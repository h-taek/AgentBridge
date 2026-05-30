import type { CliKind, TurnsAssistantDetail } from '@shared/ipc'
import type { TurnToolCall } from '@shared/turns'
import { TURN_CAP, TURNS_ASSISTANT_DETAIL_CAP } from '@shared/turns'

// sliceAssistant — M3 O 청크. architecture §15.3.
//
// PTY raw replay(display-filter 적용 후)에서 user/assistant 분리 + toolCalls 추출.
// 모델별(claude/codex/gemini) chrome 패턴 분기.
//
// 6-단계 pipeline:
//   1. normalizeTerminal — alt-screen + ANSI + 제어문자 strip + \r\n 정규화
//   2. extractToolCalls — claude `⏺ <CapTool>(<arg>)` 앵커드 regex만 (보수적)
//   3. removeToolBlocks — tool로 매칭된 라인 + 결과 라인 본문에서 제거
//   4. compactBody — model별 chrome 필터 + 연속 동일 라인 dedup + 공백 정규화
//   5. streamingPrefixDedup — 빈 줄 구분 블록 단위 prefix/identical 폐기 (gemini streaming 대응)
//   6. applyBodyCap — 앞 400 + 뒤 100 (결론부 보존)

// ANSI escape pattern — CSI / OSC / DCS / single-shift 모두 커버.
const ANSI_RE = new RegExp(
  '\\u001b\\[[0-?]*[ -/]*[@-~]' +
    '|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)' +
    '|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\' +
    '|\\u001b[@-Z\\\\\\-_]',
  'g'
)

// alt-screen begin/end 사이 본문은 임시 UI(로딩/메뉴 등) — 통째 drop.
const ALT_SCREEN_RE = new RegExp(
  '\\u001b' + '\\[\\?1049h[\\s\\S]*?' + '\\u001b' + '\\[\\?1049l',
  'g'
)

// LF/TAB/CR 보존, 나머지 C0/DEL 제거. RegExp 생성자 + escape — raw control byte 회피.
const CONTROL_RE = new RegExp(
  '[' + '\\u0000-\\u0008' + '\\u000b\\u000c' + '\\u000e-\\u001f\\u007f' + ']',
  'g'
)

export type SliceResult = {
  assistantBody: string
  assistantBodyBytes: number
  toolCalls: TurnToolCall[]
}

// ─── 1단계: normalize ──────────────────────────────────────────────────

function normalizeTerminal(raw: string): string {
  let s = raw.replace(ALT_SCREEN_RE, '')
  s = s.replace(ANSI_RE, '')
  s = s.replace(CONTROL_RE, '')
  s = s.replace(/\r\n?/g, '\n')
  return s
}

// ─── 2단계: toolCalls 추출 ─────────────────────────────────────────────

// claude tool 호출: `⏺ <CapTool>(<arg>)`. 첫 글자 대문자 — `⏺ 좋아요...` 같은 prose는 매칭 안 됨.
const CLAUDE_TOOL_RE = /^[\s│]*⏺\s+([A-Z][A-Za-z0-9]*)\(([^)\n]*)\)\s*$/
const CLAUDE_RESULT_RE = /^\s*[⎿└]\s+(.*)$/

// agy(Antigravity, 구 Gemini CLI) tool 호출: `⊶  ReadFile  src/path.ts` (pending) /
// `✓  ReadFile  src/path.ts` (completed). 2 공백 + Cap-word + 2 공백 + arg 패턴.
// agy 1.0.0에서도 동일 형식 가정 — 변경 시 라이브 테스트 후 정규식 보완.
const AGY_TOOL_RE = /^\s*[⊶✓]\s+([A-Z][A-Za-z]+)\s+(.+?)\s*$/

function extractToolCalls(
  lines: string[],
  model: CliKind
): { toolCalls: TurnToolCall[]; usedLineIdx: Set<number> } {
  const toolCalls: TurnToolCall[] = []
  const usedLineIdx = new Set<number>()

  if (model === 'claude') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CLAUDE_TOOL_RE)
      if (!m) continue
      const tool = m[1]
      let arg = m[2].trim()
      if (arg.length > TURN_CAP.toolCallArgChars) {
        arg = arg.slice(0, TURN_CAP.toolCallArgChars) + '…'
      }
      let summary: string | undefined
      if (i + 1 < lines.length) {
        const r = lines[i + 1].match(CLAUDE_RESULT_RE)
        if (r) {
          const text = r[1].trim()
          if (text.length > 0) summary = text.slice(0, 200)
          usedLineIdx.add(i + 1)
        }
      }
      toolCalls.push(summary !== undefined ? { tool, arg, summary } : { tool, arg })
      usedLineIdx.add(i)
    }
    return { toolCalls, usedLineIdx }
  }

  if (model === 'agy') {
    // gemini는 streaming 중 같은 호출이 `⊶` → `✓` 두 단계로 나옴 — 같은 (tool, arg) 쌍이 다수 출현.
    // 중복 제거를 위해 set 사용.
    const seen = new Set<string>()
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(AGY_TOOL_RE)
      if (!m) continue
      const tool = m[1]
      let arg = m[2].trim()
      if (arg.length > TURN_CAP.toolCallArgChars) {
        arg = arg.slice(0, TURN_CAP.toolCallArgChars) + '…'
      }
      // gemini tool names: ReadFile / ReadFolder / WriteFile / Edit / RunShell / GoogleSearch / FindFiles 등
      // 모두 CamelCase. SPINNER_VERBS_RE에 잡히는 verb(Loading 등)와 충돌 가능성 → tool name 화이트리스트.
      if (!/^(Read|Write|Edit|Run|Find|Google|Web|Shell|Save|Load|Grep|List)/.test(tool)) continue
      const key = `${tool}|${arg}`
      if (seen.has(key)) {
        usedLineIdx.add(i)
        continue
      }
      seen.add(key)
      toolCalls.push({ tool, arg })
      usedLineIdx.add(i)
    }
    return { toolCalls, usedLineIdx }
  }

  // codex — 명시적 tool marker 부재(`•` 마커가 hook status/prose와 겹침). 보수적으로 skip.
  // 첫 cut에서 false positive 회피. 추후 사용자가 안정적 패턴 식별하면 추가.
  return { toolCalls, usedLineIdx }
}

function removeToolBlocks(lines: string[], usedLineIdx: Set<number>): string[] {
  return lines.filter((_, i) => !usedLineIdx.has(i))
}

// ─── 3단계: chrome 필터 ───────────────────────────────────────────────

// spinner verb 사전 — claude/codex/gemini가 thinking/working/loading 상태에서 출력하는 gerund/완료형.
// substring 매칭으로 cursor-redraw 단편(`Iu3thinking`) 등도 catch.
const SPINNER_VERBS_RE =
  /(thinking|Thinking|Brewing|Brewed for \d+s|Churning|Churned for \d+s|Crunching|Crunched for \d+s|Crafting|Vibing|Slithering|Gesticulating|Transmuting|Fiddle-faddling|Marinating|Incubating|Pondering|Hmming|Cogitating|Ruminating|Synthesizing|Conjuring|Wrangling|Pinging|Working|Booting|Loading|Generating|Compiling|Building|Connecting|Downloading|Uploading|Initializing|Preparing|Processing|Computing|Fetching|Searching|Analyzing|Reviewing|Reasoning|Pondered|Reasoned)/

// 진행 indicator substring
const PROGRESS_INDICATOR_RE = /\(\d+s\b[^)]*\)|↓\s*\d+\s*tokens|thought for \d+s/

// 키 힌트 substring (variations include `? for shortcuts(esc to cancel, 2s)`)
const KB_HINT_RE = /(esc to interrupt|esctointerrupt|\? for shortcuts|esc to cancel|for shortcuts)/

// banner 글리프 (claude 시작 logo, codex `◉xhigh`, gemini `⧉ In .gitignore` 등)
const BANNER_GLYPH_RE = /[▐▛▜▘▝▀▄█◉⧉]/

// gemini 브라일 스피너 + 박스 보더는 별도 검사
const BRAILLE_RE = /[⠀-⣿]/
const BOX_CHARS_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋▄▀█▌▐░▒▓]/g

// 공통 chrome — 모든 모델에 적용.
function isCommonChrome(t: string): boolean {
  // gemini 시작 WARNING (multi-line — hook command path 잔재 포함)
  if (/^⚠\s+WARNING:/.test(t)) return true
  if (/^These hooks will be executed/.test(t)) return true
  if (/^please review the project settings/.test(t)) return true
  if (/^-\s+node\s+['"]/.test(t)) return true
  if (/^Documents\/com~apple~CloudDocs/.test(t)) return true
  if (/^mory\.js'?\s+inject/.test(t)) return true
  if (/^['"]\/Users\/.*Library\/Application Support/.test(t)) return true

  // ptyDisplayFilter가 삽입한 marker
  if (/\[hook context hidden\]/.test(t)) return true

  // 스피너 글리프 / banner / braille
  if (/[✳✶✻✽✢]/.test(t)) return true
  if (BANNER_GLYPH_RE.test(t)) return true
  if (BRAILLE_RE.test(t)) return true

  // 단일 letter/digit/CJK 라인 — cursor-redraw 잔재
  if (t.length === 1 && /\p{L}|\p{N}/u.test(t)) return true

  // 짧은 ASCII-only (≤6)
  if (t.length <= 6 && /^[A-Za-z0-9…]+$/.test(t)) return true

  // 짧은 한글+구두점 (≤3) — user input cursor-redraw
  if (t.length <= 3 && /^[\p{sc=Hangul}\p{sc=Han}.,!?…]+$/u.test(t)) return true

  // 장식 char + 숫자/공백/ellipsis (token-count 단편)
  if (/^[·…↓0-9\s]+$/.test(t) && t.length <= 8) return true

  // `·` decorator + 짧은 ASCII 단편 (spinner cursor-redraw)
  if (/^·[A-Za-z]+…?\d*$/.test(t) && t.length <= 12) return true

  // 단독 Cap 영단어 (spinner verb 통째 + Tip wrap 잔재)
  if (/^[A-Z][A-Za-z-]{2,19}…?\s*\d*$/.test(t)) return true

  // dash 박스 보더
  if (/^[─━_=-]{3,}$/.test(t)) return true

  // 박스 라인 (양끝 `│`로 감싸진 라인)
  if (/^│.*│\s*$/.test(t)) return true

  // 박스 비율 높은 라인 (gemini ╭╮╰╯─│ 등)
  const boxChars = (t.match(BOX_CHARS_RE) || []).length
  if (boxChars >= 3 && boxChars >= t.length * 0.3) return true

  // spinner verb / progress / keyboard hint
  if (SPINNER_VERBS_RE.test(t)) return true
  if (PROGRESS_INDICATOR_RE.test(t)) return true
  if (KB_HINT_RE.test(t)) return true

  // claude/codex 시작 tip
  if (/^[⎿└]\s*Tip:/.test(t)) return true
  if (/^Tip:\s+(Try the Codex|Use|Run)/i.test(t)) return true
  if (/^PATH["\s]?\s*to ?enable/i.test(t)) return true

  return false
}

// 모델별 chrome 분기.
function isChromeForModel(raw: string, model: CliKind): boolean {
  const t = raw.trim()
  if (t === '') return false
  if (isCommonChrome(t)) return true

  if (model === 'claude') {
    // claude `❯` prompt + 내용 (user echo redraw)
    if (t === '❯' || /^❯[\s ]/.test(t)) return true
  }

  if (model === 'codex') {
    // codex `›` prompt + 내용
    if (t === '›' || /^›[\s ]/.test(t)) return true
    // `•Cap` cursor-redraw (no space + Capital → spinner verb redraw 단편)
    if (/^•[A-Z]/.test(t)) return true
    // `• <Cap> hook (completed/running/started/failed)` hook status
    if (/^•\s+\w+\s+hook\s+\((completed|running|started|failed)\)/i.test(t)) return true
    // codex /hooks UI form fields (`Event   SessionStart`, `Trust   Trusted` 등)
    if (
      /^(Event|Matcher|Source|Command|Timeout|Trust|Description|Hooks|Installed|Active|Review)(\s{2,}|\s+\d|\s+[A-Z])/.test(
        t
      )
    )
      return true
    // codex /hooks UI 이벤트 row: `PreToolUse  0  0  ...`
    if (
      /^(PreToolUse|PostToolUse|PermissionRequest|PreCompact|PostCompact|SessionStart|UserPromptSubmit|Stop)\s+\d+\s+\d+/.test(
        t
      )
    )
      return true
    // `Press X to Y` 힌트
    if (/^Press (space|enter|t|esc)\b/.test(t)) return true
    // `[ ] Hook N`, `[!] Hook N · modified`
    if (/^\[[\s!x]*\]\s+Hook\s+\d/.test(t)) return true
    // codex placeholder `Write tests for @filename`
    if (/Write tests for @filename/.test(t)) return true
    // codex status bar: `gpt-5.5 high · ~/...`
    if (/^(gpt-[\d.]+|claude-[\d.]+|gemini-[\d.]+|o\d)\s+(high|medium|low)/.test(t)) return true
    // OpenAI Codex 시작 banner
    if (/^>_ OpenAI Codex/.test(t)) return true
    if (/^(model:|directory:)\s/.test(t)) return true
  }

  if (model === 'agy') {
    // gemini specific UI strings
    if (
      /^(Shift\+Tab to accept edits|Type your message|workspace \(\/directory\)|\d+ GEMINI\.md file|Executing Hook:|using GEMINI\.md)/.test(
        t
      )
    )
      return true
    // gemini status bar header `branch    sandbox    /model    quota`
    if (/^branch\s+sandbox\s+\/model\s+quota/.test(t)) return true
    // gemini status bar value: `~/.../path    main    no sandbox    Auto (Gemini X)    N% used`
    if (/\b(no sandbox|sandbox\s+ON)\b.*\b(Auto|Gemini|Pro|Flash)\b.*\d+%/.test(t)) return true
    // gemini prompt `>` + 내용 (user input redraw — claude `❯`와 다른 글리프)
    if (/^>\s+/.test(t)) return true
  }

  return false
}

// ─── 4단계: streaming prefix dedup ────────────────────────────────────
//
// gemini는 응답 streaming 시 매번 더 긴 버전을 통째 redraw — 빈 줄로 구분된 블록 단위로 중복.
// `*` / `~` / `_` / `` ` `` 같은 markdown 토큰을 정규화한 뒤 prefix/identical 검사.

function streamingPrefixDedup(text: string): string {
  const blocks = text.split(/\n\n+/)
  const out: string[] = []
  const norm = (s: string): string => s.replace(/[`*~_]/g, '').trim()
  for (const block of blocks) {
    if (out.length === 0) {
      out.push(block)
      continue
    }
    const prevNorm = norm(out[out.length - 1])
    const blockNorm = norm(block)
    if (prevNorm === blockNorm) continue
    if (blockNorm.startsWith(prevNorm)) {
      out[out.length - 1] = block
    } else if (prevNorm.startsWith(blockNorm)) {
      continue
    } else {
      out.push(block)
    }
  }
  return out.join('\n\n')
}

function compactBody(lines: string[], model: CliKind): string {
  const filtered = lines.filter((l) => !isChromeForModel(l, model))
  // 연속 동일 라인 dedup (TUI redraw 잔재)
  const deduped: string[] = []
  let prev: string | null = null
  for (const line of filtered) {
    // \s+$/ 대신 단순 줄바꿈 제거 (한글 뒤 공백 보존 고려)
    const norm = line.replace(/[\r\n]+$/, '')
    if (norm === prev) continue
    deduped.push(norm)
    prev = norm
  }
  let text = deduped.join('\n').replace(/\n{4,}/g, '\n\n\n')
  text = streamingPrefixDedup(text)
  return text
}

// ─── 5단계: body cap — detail level별 길이 ─────────────────────────────
// 사용자 설정 turnsAssistantDetail에 따라 cap 크기 분기. TURNS_ASSISTANT_DETAIL_CAP은
// shared/turns.ts에 정의 (full=50KB, compact=500, minimal=200).

function applyBodyCap(body: string, detail: TurnsAssistantDetail): string {
  const { chars, headChars, tailChars } = TURNS_ASSISTANT_DETAIL_CAP[detail]
  if (body.length <= chars) return body
  return body.slice(0, headChars) + '\n…[truncated]…\n' + body.slice(body.length - tailChars)
}

// ─── 최종 ─────────────────────────────────────────────────────────────

export function sliceAssistant(args: {
  raw: string
  model: CliKind
  detail?: TurnsAssistantDetail
}): SliceResult {
  const detail = args.detail ?? 'compact'
  const normalized = normalizeTerminal(args.raw)
  const lines = normalized.split('\n')
  const { toolCalls, usedLineIdx } = extractToolCalls(lines, args.model)
  const bodyLines = removeToolBlocks(lines, usedLineIdx)
  const compacted = compactBody(bodyLines, args.model)
  const capped = applyBodyCap(compacted, detail)
  return {
    assistantBody: capped,
    assistantBodyBytes: Buffer.byteLength(capped, 'utf8'),
    toolCalls
  }
}
