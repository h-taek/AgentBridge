// sliceAssistant — PTY raw replay(display-filter 적용 후)에서 user/assistant 분리 + toolCalls 추출.
// 모델별(claude/codex/agy) chrome 패턴 분기.
//
// 6-단계 pipeline:
//   1. normalizeTerminal — alt-screen + ANSI + 제어문자 strip + \r\n 정규화
//   2. extractToolCalls — claude `⏺ <CapTool>(<arg>)` 앵커드 regex만 (보수적)
//   3. removeToolBlocks — tool로 매칭된 라인 + 결과 라인 본문에서 제거
//   4. compactBody — model별 chrome 필터 + 연속 동일 라인 dedup + 공백 정규화
//   5. streamingPrefixDedup — 빈 줄 구분 블록 단위 prefix/identical 폐기 (gemini streaming 대응)
//   6. applyBodyCap — 앞 N + 뒤 M (결론부 보존)

import type { CliKind } from '../shared/cli';
import type { TurnToolCall, TurnsAssistantDetail } from '../shared/turns';
import { TURN_CAP, TURNS_ASSISTANT_DETAIL_CAP } from '../shared/turns';

// Whitelist of agy tool name prefixes accepted by extractToolCalls.
// NOTE: 코드리뷰에서 unanchored 매칭 이슈가 보고됨 (`^Read`가 prose의 `Reading`을 잡음).
// 이관은 우선 faithful copy. 마이그레이션 안정화 후 별도 PR에서 `$`로 앵커 수정 예정.
const AGY_TOOL_PREFIXES = [
  'Read', 'Write', 'Edit', 'Run', 'Find', 'Google',
  'Web', 'Shell', 'Save', 'Load', 'Grep', 'List',
];
const AGY_TOOL_PREFIX_RE = new RegExp('^(' + AGY_TOOL_PREFIXES.join('|') + ')');

// ANSI escape pattern — CSI / OSC / DCS / single-shift 모두 커버.
const ANSI_RE = new RegExp(
  '\\u001b\\[[0-?]*[ -/]*[@-~]' +
    '|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)' +
    '|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\' +
    '|\\u001b[@-Z\\\\\\-_]',
  'g',
);

// alt-screen begin/end 사이 본문은 임시 UI(로딩/메뉴 등) — 통째 drop.
const ALT_SCREEN_RE = new RegExp(
  '\\u001b' + '\\[\\?1049h[\\s\\S]*?' + '\\u001b' + '\\[\\?1049l',
  'g',
);

// LF/TAB/CR 보존, 나머지 C0/DEL 제거.
const CONTROL_RE = new RegExp(
  '[' + '\\u0000-\\u0008' + '\\u000b\\u000c' + '\\u000e-\\u001f\\u007f' + ']',
  'g',
);

export type SliceResult = {
  assistantBody: string;
  assistantBodyBytes: number;
  toolCalls: TurnToolCall[];
};

// ─── 1단계: normalize ──────────────────────────────────────────────────

function normalizeTerminal(raw: string): string {
  let s = raw.replace(ALT_SCREEN_RE, '');
  s = s.replace(ANSI_RE, '');
  s = s.replace(CONTROL_RE, '');
  s = s.replace(/\r\n?/g, '\n');
  return s;
}

// ─── 2단계: toolCalls 추출 ─────────────────────────────────────────────

const CLAUDE_TOOL_RE = /^[\s│]*⏺\s+([A-Z][A-Za-z0-9]*)\(([^)\n]*)\)\s*$/;
const CLAUDE_RESULT_RE = /^\s*[⎿└]\s+(.*)$/;

const AGY_TOOL_RE = /^\s*[⊶✓]\s+([A-Z][A-Za-z]+)\s+(.+?)\s*$/;

function extractToolCalls(
  lines: string[],
  model: CliKind,
): { toolCalls: TurnToolCall[]; usedLineIdx: Set<number> } {
  const toolCalls: TurnToolCall[] = [];
  const usedLineIdx = new Set<number>();

  if (model === 'claude') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CLAUDE_TOOL_RE);
      if (!m) continue;
      const tool = m[1];
      let arg = m[2].trim();
      if (arg.length > TURN_CAP.toolCallArgChars) {
        arg = arg.slice(0, TURN_CAP.toolCallArgChars) + '…';
      }
      let summary: string | undefined;
      if (i + 1 < lines.length) {
        const r = lines[i + 1].match(CLAUDE_RESULT_RE);
        if (r) {
          const text = r[1].trim();
          if (text.length > 0) summary = text.slice(0, 200);
          usedLineIdx.add(i + 1);
        }
      }
      toolCalls.push(summary !== undefined ? { tool, arg, summary } : { tool, arg });
      usedLineIdx.add(i);
    }
    return { toolCalls, usedLineIdx };
  }

  if (model === 'agy') {
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(AGY_TOOL_RE);
      if (!m) continue;
      const tool = m[1];
      let arg = m[2].trim();
      if (arg.length > TURN_CAP.toolCallArgChars) {
        arg = arg.slice(0, TURN_CAP.toolCallArgChars) + '…';
      }
      if (!AGY_TOOL_PREFIX_RE.test(tool)) continue;
      const key = `${tool}|${arg}`;
      if (seen.has(key)) {
        usedLineIdx.add(i);
        continue;
      }
      seen.add(key);
      toolCalls.push({ tool, arg });
      usedLineIdx.add(i);
    }
    return { toolCalls, usedLineIdx };
  }

  // codex — 명시적 tool marker 부재(`•` 마커가 hook status/prose와 겹침). 보수적으로 skip.
  return { toolCalls, usedLineIdx };
}

function removeToolBlocks(lines: string[], usedLineIdx: Set<number>): string[] {
  return lines.filter((_, i) => !usedLineIdx.has(i));
}

// ─── 3단계: chrome 필터 ───────────────────────────────────────────────

const SPINNER_VERBS_RE =
  /(thinking|Thinking|Brewing|Brewed for \d+s|Churning|Churned for \d+s|Crunching|Crunched for \d+s|Crafting|Vibing|Slithering|Gesticulating|Transmuting|Fiddle-faddling|Marinating|Incubating|Pondering|Hmming|Cogitating|Ruminating|Synthesizing|Conjuring|Wrangling|Pinging|Working|Booting|Loading|Generating|Compiling|Building|Connecting|Downloading|Uploading|Initializing|Preparing|Processing|Computing|Fetching|Searching|Analyzing|Reviewing|Reasoning|Pondered|Reasoned)/;

const PROGRESS_INDICATOR_RE = /\(\d+s\b[^)]*\)|↓\s*\d+\s*tokens|thought for \d+s/;

const KB_HINT_RE = /(esc to interrupt|esctointerrupt|\? for shortcuts|esc to cancel|for shortcuts)/;

const BANNER_GLYPH_RE = /[▐▛▜▘▝▀▄█◉⧉]/;

const BRAILLE_RE = /[⠀-⣿]/;
const BOX_CHARS_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋▄▀█▌▐░▒▓]/g;

function isCommonChrome(t: string): boolean {
  if (/^⚠\s+WARNING:/.test(t)) return true;
  if (/^These hooks will be executed/.test(t)) return true;
  if (/^please review the project settings/.test(t)) return true;
  if (/^-\s+node\s+['"]/.test(t)) return true;
  if (/^Documents\/com~apple~CloudDocs/.test(t)) return true;
  if (/^mory\.js'?\s+inject/.test(t)) return true;
  if (/^['"]\/Users\/.*Library\/Application Support/.test(t)) return true;

  if (/\[hook context hidden\]/.test(t)) return true;

  if (/[✳✶✻✽✢]/.test(t)) return true;
  if (BANNER_GLYPH_RE.test(t)) return true;
  if (BRAILLE_RE.test(t)) return true;

  if (t.length === 1 && /\p{L}|\p{N}/u.test(t)) return true;

  if (t.length <= 6 && /^[A-Za-z0-9…]+$/.test(t)) return true;

  if (t.length <= 3 && /^[\p{sc=Hangul}\p{sc=Han}.,!?…]+$/u.test(t)) return true;

  if (/^[·…↓0-9\s]+$/.test(t) && t.length <= 8) return true;

  if (/^·[A-Za-z]+…?\d*$/.test(t) && t.length <= 12) return true;

  if (/^[A-Z][A-Za-z-]{2,19}…?\s*\d*$/.test(t)) return true;

  if (/^[─━_=-]{3,}$/.test(t)) return true;

  if (/^│.*│\s*$/.test(t)) return true;

  const boxChars = (t.match(BOX_CHARS_RE) || []).length;
  if (boxChars >= 3 && boxChars >= t.length * 0.3) return true;

  if (SPINNER_VERBS_RE.test(t)) return true;
  if (PROGRESS_INDICATOR_RE.test(t)) return true;
  if (KB_HINT_RE.test(t)) return true;

  if (/^[⎿└]\s*Tip:/.test(t)) return true;
  if (/^Tip:\s+(Try the Codex|Use|Run)/i.test(t)) return true;
  if (/^PATH["\s]?\s*to ?enable/i.test(t)) return true;

  return false;
}

function isChromeForModel(raw: string, model: CliKind): boolean {
  const t = raw.trim();
  if (t === '') return false;
  if (isCommonChrome(t)) return true;

  if (model === 'claude') {
    if (t === '❯' || /^❯[\s ]/.test(t)) return true;
  }

  if (model === 'codex') {
    if (t === '›' || /^›[\s ]/.test(t)) return true;
    if (/^•[A-Z]/.test(t)) return true;
    if (/^•\s+\w+\s+hook\s+\((completed|running|started|failed)\)/i.test(t)) return true;
    if (
      /^(Event|Matcher|Source|Command|Timeout|Trust|Description|Hooks|Installed|Active|Review)(\s{2,}|\s+\d|\s+[A-Z])/.test(
        t,
      )
    )
      return true;
    if (
      /^(PreToolUse|PostToolUse|PermissionRequest|PreCompact|PostCompact|SessionStart|UserPromptSubmit|Stop)\s+\d+\s+\d+/.test(
        t,
      )
    )
      return true;
    if (/^Press (space|enter|t|esc)\b/.test(t)) return true;
    if (/^\[[\s!x]*\]\s+Hook\s+\d/.test(t)) return true;
    if (/Write tests for @filename/.test(t)) return true;
    if (/^(gpt-[\d.]+|claude-[\d.]+|gemini-[\d.]+|o\d)\s+(high|medium|low)/.test(t)) return true;
    if (/^>_ OpenAI Codex/.test(t)) return true;
    if (/^(model:|directory:)\s/.test(t)) return true;
  }

  if (model === 'agy') {
    if (
      /^(Shift\+Tab to accept edits|Type your message|workspace \(\/directory\)|\d+ GEMINI\.md file|Executing Hook:|using GEMINI\.md)/.test(
        t,
      )
    )
      return true;
    if (/^branch\s+sandbox\s+\/model\s+quota/.test(t)) return true;
    if (/\b(no sandbox|sandbox\s+ON)\b.*\b(Auto|Gemini|Pro|Flash)\b.*\d+%/.test(t)) return true;
    if (/^>\s+/.test(t)) return true;
  }

  return false;
}

// ─── 4단계: streaming prefix dedup ────────────────────────────────────

function streamingPrefixDedup(text: string): string {
  const blocks = text.split(/\n\n+/);
  const out: string[] = [];
  const norm = (s: string): string => s.replace(/[`*~_]/g, '').trim();
  for (const block of blocks) {
    if (out.length === 0) {
      out.push(block);
      continue;
    }
    const prevNorm = norm(out[out.length - 1]);
    const blockNorm = norm(block);
    if (prevNorm === blockNorm) continue;
    if (blockNorm.startsWith(prevNorm)) {
      out[out.length - 1] = block;
    } else if (prevNorm.startsWith(blockNorm)) {
      continue;
    } else {
      out.push(block);
    }
  }
  return out.join('\n\n');
}

function compactBody(lines: string[], model: CliKind): string {
  const filtered = lines.filter((l) => !isChromeForModel(l, model));
  const deduped: string[] = [];
  let prev: string | null = null;
  for (const line of filtered) {
    const norm = line.replace(/[\r\n]+$/, '');
    if (norm === prev) continue;
    deduped.push(norm);
    prev = norm;
  }
  let text = deduped.join('\n').replace(/\n{4,}/g, '\n\n\n');
  text = streamingPrefixDedup(text);
  return text;
}

// ─── 5단계: body cap ───────────────────────────────────────────────────

function applyBodyCap(body: string, detail: TurnsAssistantDetail): string {
  const { chars, headChars, tailChars } = TURNS_ASSISTANT_DETAIL_CAP[detail];
  if (body.length <= chars) return body;
  if (tailChars <= 0) return body.slice(0, headChars);
  return body.slice(0, headChars) + '\n…[truncated]…\n' + body.slice(body.length - tailChars);
}

// ─── 최종 ─────────────────────────────────────────────────────────────

export function sliceAssistant(args: {
  raw: string;
  model: CliKind;
  detail?: TurnsAssistantDetail;
}): SliceResult {
  const detail = args.detail ?? 'compact';
  const normalized = normalizeTerminal(args.raw);
  const lines = normalized.split('\n');
  const { toolCalls, usedLineIdx } = extractToolCalls(lines, args.model);
  const bodyLines = removeToolBlocks(lines, usedLineIdx);
  const compacted = compactBody(bodyLines, args.model);
  const capped = applyBodyCap(compacted, detail);
  return {
    assistantBody: capped,
    assistantBodyBytes: utf8ByteLength(capped),
    toolCalls,
  };
}

// 플랫폼 중립적 UTF-8 byte length. Node Buffer / TextEncoder 의존 회피 — 어떤 ES2022 런타임에서도 동작.
function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++; // surrogate pair → 4 bytes, advance past low surrogate
    } else n += 3;
  }
  return n;
}
