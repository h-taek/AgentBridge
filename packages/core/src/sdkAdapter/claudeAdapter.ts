// claude 어댑터 — @anthropic-ai/claude-agent-sdk(ESM)를 지속(멀티턴) 채팅 세션으로 정규화.
// 구조: streaming-input mode — query({prompt: AsyncIterable<SDKUserMessage>})를 한 번 열고(=한 세션),
// send마다 user 메시지를 입력 스트림에 push. 한 Query 제너레이터가 모든 턴의 SDKMessage를 방출하므로
// 맥락이 유지되고 interrupt/setModel 같은 제어가 가능하다(streaming 전용).
// 백그라운드 pump가 SDKMessage→ChatEvent로 매핑해 "현재 턴" 큐에 흘리고, result에서 onTurn(TurnRecord)
// 방출 후 턴을 닫는다. 턴은 직렬(turnGate)이라 ref.current 하나로 라우팅.
// 본문 권위값: TurnRecord의 assistantBody는 최종 assistant 메시지에서만 채운다(델타는 라이브 표시용).
import { query, type Query, type SDKUserMessage, type PermissionResult, type PermissionMode as SdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { OpenTurn, ReaderCtx } from '../transcriptReader/types.js';
import { finalizeTurn, toolArgString } from '../transcriptReader/util.js';
import { AsyncQueue } from './asyncQueue.js';
import type { AccountUsage, AgentAdapter, AgentInfo, ChatEvent, LoginChallenge, McpServerInfo, PermissionMode, Session, StartOptions, UsageContributors, UsageLimit } from './types.js';

// SDK Query의 인증 메서드는 .d.ts에 미노출(런타임 객체엔 존재) → 타입만 보강.
type AuthQuery = {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<{ automaticUrl: string; manualUrl: string }>;
  claudeOAuthCallback(authorizationCode: string, state?: string): Promise<unknown>;
  claudeOAuthWaitForCompletion(): Promise<unknown>;
};

// accountInfo()의 실제 응답(라이브 probe 확정) — .d.ts 타입이 일부 필드만 노출하므로 보강.
type AccountInfo = { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string; tokenSource?: string };

// 사용량 — 실험 API(usage_EXPERIMENTAL…). 이름이 길고 버전 간 바뀔 수 있어 방어적으로만 사용.
type RawBreakdown = {
  behaviors?: Array<{ key?: string; pct?: number }>;
  agents?: Array<{ name?: string; pct?: number }>;
  skills?: Array<{ name?: string; pct?: number }>;
  plugins?: Array<{ name?: string; pct?: number }>;
  mcp_servers?: Array<{ name?: string; pct?: number }>;
};
type ExpUsage = {
  rate_limits?: { limits?: Array<{ kind?: string; percent?: number; resets_at?: string | null; scope?: { model?: { display_name?: string } } }> };
  behaviors?: { day?: RawBreakdown; week?: RawBreakdown };
};
type UsageQuery = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<ExpUsage> };

// Thinking 토글 ON 예산(OFF=0). 공식 익스텐션 Thinking 토글에 대응(확장 사고 활성).
const THINKING_ON_BUDGET = 31_999;

// rate_limits.limits[].kind → 화면 라벨.
function limitLabel(l: { kind?: string; scope?: { model?: { display_name?: string } } }): string {
  switch (l.kind) {
    case 'session': return 'Session (5hr)';
    case 'weekly_all': return 'Weekly (7 day)';
    case 'weekly_scoped': return `Weekly ${l.scope?.model?.display_name ?? ''}`.trim();
    default: return l.kind ?? '';
  }
}
function mapBreakdown(b: RawBreakdown | undefined): UsageContributors {
  const pick = (a?: Array<{ name?: string; pct?: number }>) => (a ?? []).map((x) => ({ name: x.name ?? '', pct: x.pct ?? 0 }));
  return {
    behaviors: (b?.behaviors ?? []).map((x) => ({ key: x.key ?? '', pct: x.pct ?? 0 })),
    agents: pick(b?.agents),
    skills: pick(b?.skills),
    plugins: pick(b?.plugins),
    mcpServers: pick(b?.mcp_servers),
  };
}

// 우리 PermissionMode → SDK PermissionMode. claude가 처리하는 4개만(codex 전용 id는 undefined → 무시).
const CLAUDE_MODE: Partial<Record<PermissionMode, SdkPermissionMode>> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
};

type ActiveTurn = { events: AsyncQueue<ChatEvent>; open: OpenTurn };

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  async start(opts: StartOptions): Promise<Session> {
    const input = new AsyncQueue<SDKUserMessage>();

    let sessionId = opts.resume ?? '';
    let model: string | undefined; // init이 주는 해석된 모델(표시용 — 풀 id)
    let selectedModel: string | undefined; // 명시 선택한 별칭(없으면 'default'가 활성)

    // 현재 진행 중인 턴. 턴 직렬(turnGate)이라 단일 슬롯으로 충분.
    // 객체 슬롯으로 보관 — IIFE pump에서 `let` 직접 읽기는 enclosing CFA가 never로 좁히는 TS 이슈를 피함.
    const ref: { current: ActiveTurn | null } = { current: null };

    // 승인 대기 resolver (5단계) — canUseTool이 'approval' 이벤트를 내고 여기 promise를 건다.
    const approvals = new Map<string, (r: PermissionResult) => void>();

    const q: Query = query({
      prompt: input,
      options: {
        cwd: opts.cwd,
        includePartialMessages: true, // 델타 스트리밍(content_block_delta)
        ...(opts.resume ? { resume: opts.resume } : {}),
        // 맥락 주입(3단계): claude 기본 프리셋 유지 + handoff/IR을 append(통째 교체 아님 — 툴 지침 보존).
        ...(opts.context
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: opts.context } }
          : {}),
        // 승인(5단계): 도구 실행 권한 요청 → 'approval' 이벤트 방출 후 respondApproval까지 대기.
        canUseTool: (toolName, toolInput, o) =>
          new Promise<PermissionResult>((resolve) => {
            const id = o.toolUseID;
            approvals.set(id, resolve);
            ref.current?.events.push({
              t: 'approval',
              id,
              title: o.title ?? `${toolName} 실행 승인`,
              detail: o.description ?? toolArgString(toolInput),
              tool: toolName,
            });
          }),
      },
    });

    // 백그라운드 소비 루프.
    const pump = (async () => {
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') {
            sessionId = m.session_id;
            model = m.model;
            // init은 (streaming-input mode) 첫 입력 이후 도착 — 그 시점의 현재 턴에 session/commands 이벤트 방출.
            ref.current?.events.push({ t: 'session', sessionId, model });
            ref.current?.events.push({ t: 'commands', commands: m.slash_commands ?? [] });
            continue;
          }
          const turn = ref.current;
          if (!turn) continue; // 턴 밖 메시지(드묾) — 무시
          if (m.type === 'stream_event') {
            const ev = m.event;
            if (ev.type === 'content_block_delta') {
              if (ev.delta.type === 'text_delta' && ev.delta.text) {
                turn.events.push({ t: 'text', text: ev.delta.text, final: false });
              } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
                turn.events.push({ t: 'thinking', text: ev.delta.thinking });
              }
            }
          } else if (m.type === 'assistant') {
            // 실제 해석된 모델(버전 포함, 예: claude-opus-4-8)을 패널 칩에 반영 — 카탈로그 별칭엔 버전이 없음.
            // 슬래시 명령(/usage 등) 응답은 합성 메시지라 model이 '<synthetic>' → 실제 'claude…' 모델만 반영.
            if (m.message.model && m.message.model.startsWith('claude') && m.message.model !== model) {
              model = m.message.model;
              turn.events.push({ t: 'session', sessionId, model });
            }
            // 턴 고유 키 — 세션 id는 턴마다 같으므로 충돌. assistant 메시지 uuid가 턴별 안정 키
            // (SDK transcript 기준이라 resume 재방출에도 동일 → dedup 멱등).
            if (!turn.open.sourceKey) turn.open.sourceKey = m.uuid;
            for (const b of m.message.content) {
              if (b.type === 'text') {
                // 미로그인 감지 — SDK가 답변 자리에 "Not logged in"을 줌(에러 아님). 호스트가 로그인 화면 표출.
                if (/not logged in/i.test(b.text)) turn.events.push({ t: 'auth', loggedIn: false });
                turn.open.assistantParts.push(b.text); // TurnRecord 권위값(델타 아님)
                turn.events.push({ t: 'text', text: b.text, final: true });
              } else if (b.type === 'tool_use') {
                turn.open.toolCalls.push({ tool: b.name, arg: toolArgString(b.input) });
                turn.events.push({ t: 'tool', id: b.id, name: b.name, input: b.input, status: 'started' });
              }
            }
          } else if (m.type === 'user') {
            // 도구 결과(tool_result) → 'done' 이벤트로 OUT 표시. 우리가 push한 입력은 content가 문자열이라 걸러짐.
            const content = (m as { message?: { content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
                if (b.type === 'tool_result' && b.tool_use_id) {
                  const c = b.content;
                  const out =
                    typeof c === 'string'
                      ? c
                      : Array.isArray(c)
                        ? c.map((x) => (x && typeof x === 'object' && (x as { type?: string }).type === 'text' ? ((x as { text?: string }).text ?? '') : '')).join('')
                        : '';
                  turn.events.push({ t: 'tool', id: b.tool_use_id, name: '', input: undefined, status: 'done', output: out.slice(0, 4000) });
                }
              }
            }
          } else if (m.type === 'result') {
            if (m.subtype === 'success') {
              turn.events.push({ t: 'usage', inputTokens: m.usage.input_tokens ?? 0, outputTokens: m.usage.output_tokens ?? 0 });
            }
            if (!turn.open.sourceKey) turn.open.sourceKey = m.uuid; // assistant 없던 턴 폴백
            turn.open.lastAt = new Date().toISOString();
            const ctx: ReaderCtx = {
              workspaceId: opts.workspaceId,
              sessionId,
              detail: opts.detail ?? 'compact',
            };
            await opts.onTurn?.(finalizeTurn(turn.open, 'claude', ctx));
            turn.events.push({ t: 'turn_end', reason: m.subtype });
            turn.events.close();
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ref.current?.events.push({ t: 'error', message });
        ref.current?.events.close();
      }
    })();

    // 턴 직렬화 게이트 — 이전 턴이 끝나야 다음 send가 ref.current를 잡는다(라우팅 경쟁 방지).
    let turnGate: Promise<void> = Promise.resolve();

    const send = (text: string): AsyncIterable<ChatEvent> =>
      (async function* () {
        const prev = turnGate;
        let release!: () => void;
        turnGate = new Promise<void>((r) => (release = r));
        await prev;
        try {
          const events = new AsyncQueue<ChatEvent>();
          const open: OpenTurn = {
            sourceKey: '', // 턴별로 assistant/result uuid에서 채움(세션 id는 턴마다 같아 충돌)
            user: text,
            startedAt: new Date().toISOString(),
            lastAt: '',
            assistantParts: [],
            toolCalls: [],
          };
          ref.current = { events, open };
          // sessionId가 이미 있으면(2턴+) 즉시 session 이벤트, 첫 턴은 pump의 init이 방출.
          if (sessionId) events.push({ t: 'session', sessionId, model });
          // 입력을 먼저 push — streaming-input mode는 입력이 와야 init/응답을 방출(ready 선대기 시 데드락).
          input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
          for await (const ev of events) {
            yield ev;
          }
        } finally {
          ref.current = null;
          release();
        }
      })();

    return {
      get sessionId() {
        return sessionId;
      },
      send,
      async interrupt() {
        await q.interrupt();
      },
      async setPermissionMode(mode) {
        const m = CLAUDE_MODE[mode];
        if (m) await q.setPermissionMode(m);
      },
      async listModels() {
        // 카탈로그는 별칭(default/opus[1m]/sonnet/haiku) — init의 풀 id와 안 맞으므로 '선택 별칭'으로 현재 표시.
        const sel = selectedModel ?? 'default';
        const ms = await q.supportedModels();
        return ms.map((m) => {
          const efforts: string[] = m.supportedEffortLevels ? [...m.supportedEffortLevels] : [];
          if (efforts.includes('xhigh')) efforts.push('ultra'); // ultracode = xhigh + 워크플로우(xhigh 지원 모델만)
          return { id: m.value, label: m.displayName, desc: m.description, current: m.value === sel, efforts };
        });
      },
      async setModel(id) {
        await q.setModel(id);
        selectedModel = id; // 표시용 model(풀 id)은 안 건드림 — 패널 칩은 사용자가 고른 라벨을 유지.
      },
      async setEffort(level) {
        // 실제 claude 익스텐션과 동일: flag settings 레이어 주입(즉시 적용, 스트리밍 전용).
        // 'ultra' = ultracode(xhigh effort + 동적 워크플로우). 그 외는 effortLevel + ultracode 해제.
        if (level === 'ultra') {
          await q.applyFlagSettings({ effortLevel: 'xhigh', ultracode: true });
        } else {
          // Settings.effortLevel 타입은 xhigh까지지만, 실제 익스텐션은 supportedEffortLevels('max' 포함)를 그대로 전달 → 'max'도 런타임 통과.
          await q.applyFlagSettings({ effortLevel: level as 'low' | 'medium' | 'high' | 'xhigh', ultracode: false });
        }
      },
      async setThinking(on) {
        await q.setMaxThinkingTokens(on ? THINKING_ON_BUDGET : 0);
      },
      async getAccountUsage(): Promise<AccountUsage> {
        const info = (await q.accountInfo().catch(() => ({}))) as unknown as AccountInfo;
        const account = {
          authMethod: info.apiProvider === 'firstParty' ? 'Claude AI' : info.apiProvider,
          email: info.email,
          organization: info.organization,
          plan: info.subscriptionType,
        };
        let limits: UsageLimit[] = [];
        let contributors: AccountUsage['contributors'];
        // 실험 API — 없거나 던지면 계정 정보만 반환(화면은 USAGE 섹션을 숨김).
        const usageFn = (q as unknown as UsageQuery).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (typeof usageFn === 'function') {
          try {
            const u = await usageFn.call(q as unknown as UsageQuery);
            limits = (u.rate_limits?.limits ?? []).map((l) => ({ label: limitLabel(l), percent: l.percent ?? 0, resetsAt: l.resets_at ?? null }));
            if (u.behaviors) contributors = { day: mapBreakdown(u.behaviors.day), week: mapBreakdown(u.behaviors.week) };
          } catch { /* 실험 API 실패 — limits/contributors 생략 */ }
        }
        return { account, limits, contributors };
      },
      async listOutputStyles() {
        const r = (await q.initializationResult()) as unknown as { output_style?: string; available_output_styles?: string[] };
        return { current: r.output_style ?? 'default', available: r.available_output_styles ?? [] };
      },
      async setOutputStyle(style) {
        await q.applyFlagSettings({ outputStyle: style });
      },
      async listMcpServers(): Promise<McpServerInfo[]> {
        const list = (await q.mcpServerStatus()) as unknown as Array<{ name?: string; status?: string; tools?: unknown }>;
        return (list ?? []).map((s) => ({
          name: s.name ?? '',
          connected: s.status === 'connected',
          enabled: s.status !== 'disabled',
          toolCount: Array.isArray(s.tools) ? s.tools.length : s.tools && typeof s.tools === 'object' ? Object.keys(s.tools).length : 0,
        }));
      },
      async setMcpServerEnabled(name, enabled) {
        await q.toggleMcpServer(name, enabled);
      },
      async listAgents(): Promise<AgentInfo[]> {
        const a = (await q.supportedAgents()) as unknown as Array<{ name?: string; description?: string }>;
        return (a ?? []).map((x) => ({ name: x.name ?? '', description: x.description }));
      },
      async compact() {
        return false; // claude SDK 0.3.x엔 압축 API 없음(/compact는 TUI 전용) — UI에서 비활성.
      },
      async listCommands() {
        // 첫 send 전에도 동작(라이브 확인) — 전체 슬래시 명령 이름.
        const cmds = (await q.supportedCommands().catch(() => [])) as unknown as Array<{ name?: string }>;
        return cmds.map((c) => c.name ?? '').filter(Boolean);
      },
      async suggestTitle(firstMessage) {
        // SDK 내장 — 첫 메시지 기준 짧은 제목 생성(라이브 확인). 타입 미노출 → 캐스트.
        try {
          const t = await (q as unknown as { generateSessionTitle(m: string): Promise<string> }).generateSessionTitle(firstMessage);
          return typeof t === 'string' && t.trim() ? t.trim() : null;
        } catch {
          return null;
        }
      },
      respondApproval(id, approve) {
        const resolve = approvals.get(id);
        if (resolve) {
          approvals.delete(id);
          resolve(approve ? { behavior: 'allow' } : { behavior: 'deny', message: '사용자가 거부함' });
        }
      },
      async checkAuth() {
        // accountInfo는 입력(첫 메시지) 없이도 호출됨. 미로그인=tokenSource:'none'(email 없음).
        try {
          const a = await q.accountInfo();
          return Boolean(a.email) || (Boolean(a.tokenSource) && a.tokenSource !== 'none');
        } catch {
          return true; // 조회 실패 시 차단하지 않음(로그인된 것으로 가정)
        }
      },
      async startLogin(): Promise<LoginChallenge> {
        // loginWithClaudeAi=true → 구독(Pro/Max) 로그인. SDK가 OAuth URL 2종 반환 + 로컬 콜백서버 기동.
        const r = await (q as unknown as AuthQuery).claudeAuthenticate(true);
        return { automaticUrl: r.automaticUrl, manualUrl: r.manualUrl };
      },
      async waitLogin() {
        // 자동 모드 — 콜백서버가 코드 수신→SDK가 토큰 키체인 저장까지 끝나면 resolve.
        try {
          await (q as unknown as AuthQuery).claudeOAuthWaitForCompletion();
          return true;
        } catch {
          return false;
        }
      },
      async submitLoginCode(code, state) {
        try {
          await (q as unknown as AuthQuery).claudeOAuthCallback(code, state);
          return true;
        } catch {
          return false;
        }
      },
      async end() {
        input.close();
        await pump;
      },
    };
  },
};
