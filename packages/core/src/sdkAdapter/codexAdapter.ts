// codex 어댑터 — `codex app-server`(줄바꿈 JSON-RPC over stdio)를 claude와 동일한 AgentAdapter로 정규화.
// codex는 임베드 SDK가 아니라 독립 바이너리라 app-server를 자식 프로세스로 띄운다(claude=in-process와 다른 점).
// SDK-free(child_process + JSON only)라 번들에 그대로 들어가도 안전 → index 배럴 export·정적 import OK.
//
// 프로토콜(codex-cli 0.139, `codex app-server generate-ts` + 라이브 프로브로 확정):
//   initialize → (notify)initialized → thread/start({cwd,approvalPolicy,sandbox,developerInstructions}) → result.thread.id
//   turn/start({threadId, input:[{type:'text',text,text_elements:[]}]}) → result.turn.id
//   알림: item/agentMessage/delta(.delta=텍스트 델타), item/reasoning/textDelta(.delta=thinking),
//         item/completed(item.type==='agentMessage' → item.text=완결본 / 'commandExecution' → 도구),
//         thread/tokenUsage/updated, turn/completed, error
//   중단: turn/interrupt({threadId,turnId}). 승인: 서버→클라 request(item/.../requestApproval) → {decision}.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { OpenTurn, ReaderCtx } from '../transcriptReader/types.js';
import { finalizeTurn, toolArgString } from '../transcriptReader/util.js';
import { AsyncQueue } from './asyncQueue.js';
import type { AccountUsage, AgentAdapter, AgentInfo, ChatEvent, LoginChallenge, McpServerInfo, PermissionMode, Session, StartOptions, UsageLimit } from './types.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type ActiveTurn = { events: AsyncQueue<ChatEvent>; open: OpenTurn; turnId: string };
type AnyMsg = { id?: number; method?: string; result?: unknown; error?: unknown; params?: Record<string, unknown> };

// 권한 모드 → codex approvalPolicy + sandboxPolicy(turn/start 오버라이드). codex TUI의 3개 모드와 동일.
//   default(Default permissions) · autoReview(Auto-review) · fullAccess(Full access).
// turn/start.sandboxPolicy는 구조체(SandboxPolicy). 모드 전환 시 항상 명시해 이전 오버라이드를 리셋한다.
function codexPerm(mode: PermissionMode, cwd: string): { approvalPolicy: string; sandboxPolicy: unknown } | null {
  const workspaceWrite = { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  switch (mode) {
    case 'default': return { approvalPolicy: 'on-request', sandboxPolicy: workspaceWrite };
    case 'autoReview': return { approvalPolicy: 'on-failure', sandboxPolicy: workspaceWrite };
    case 'fullAccess': return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    default: return null; // claude 전용 모드 — 무시
  }
}

// account/rateLimits/read의 윈도우 — primary(5hr)/secondary(weekly). resetsAt=unix초.
type CodexWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
function codexWindowLabel(mins?: number): string {
  if (mins === 300) return 'Session (5hr)';
  if (mins === 10080) return 'Weekly (7 day)';
  if (mins && mins >= 1440) return `Weekly (${Math.round(mins / 1440)} day)`;
  return mins ? `Session (${Math.round(mins / 60)}hr)` : 'Usage';
}

const APPROVAL_TITLES: Record<string, string> = {
  'item/commandExecution/requestApproval': '명령 실행 승인',
  'item/fileChange/requestApproval': '파일 변경 승인',
  execCommandApproval: '명령 실행 승인',
  applyPatchApproval: '파일 변경 승인',
};

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  async start(opts: StartOptions): Promise<Session> {
    const child: ChildProcess = spawn('codex', ['app-server', '--stdio'], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });

    let rpcId = 0;
    const pending = new Map<number, Pending>();
    const approvals = new Map<string, number>(); // approval id(=string rpcId) → 원본 rpc id (응답용)
    const ref: { current: ActiveTurn | null } = { current: null };
    let threadId = opts.resume ?? '';
    let approvalPolicy = 'on-request'; // 권한 모드(6-2) — 다음 turn/start에 실어 보냄
    let sandboxPolicy: unknown = undefined; // 권한 모드 전환 시에만 설정(미설정=thread/start의 workspace-write)
    let model: string | null = null; // 모델(6-3) — null=codex 기본, 설정 시 다음 turn/start에 오버라이드
    let effort: string | null = null; // 추론 effort — null=기본, 설정 시 turn/start.effort 오버라이드
    let loginWaiter: { loginId: string | null; resolve: (ok: boolean) => void } | null = null; // 로그인 완료 대기
    let pendingLoginId: string | null = null; // startLogin이 받은 loginId(waitLogin이 매칭)

    const write = (msg: unknown): void => {
      child.stdin?.write(JSON.stringify(msg) + '\n');
    };
    const request = (method: string, params: unknown): Promise<unknown> => {
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params });
      });
    };
    const notify = (method: string, params: unknown): void => write({ jsonrpc: '2.0', method, params });

    rl.on('line', (line: string) => {
      let m: AnyMsg;
      try {
        m = JSON.parse(line) as AnyMsg;
      } catch {
        return;
      }
      // 1) 내 요청의 응답 (id + result/error, method 없음)
      if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.error !== undefined) p.reject(m.error);
          else p.resolve(m.result);
        }
        return;
      }
      // 2) 서버→클라 요청(승인 — 5단계). 'approval' 이벤트로 띄우고 respondApproval(id, approve)까지 대기.
      if (m.method && m.id != null) {
        const id = String(m.id);
        approvals.set(id, m.id);
        ref.current?.events.push({
          t: 'approval',
          id,
          title: APPROVAL_TITLES[m.method] ?? m.method,
          detail: JSON.stringify(m.params ?? {}).slice(0, 300),
          tool: m.method,
        });
        return;
      }
      // 3) 알림
      if (!m.method) return;
      // 로그인 완료 알림(turn 무관) — waitLogin resolver를 깨운다.
      if (m.method === 'account/login/completed') {
        const lp = (m.params ?? {}) as { loginId?: string | null; success?: boolean };
        if (loginWaiter && (loginWaiter.loginId == null || loginWaiter.loginId === lp.loginId)) {
          loginWaiter.resolve(Boolean(lp.success));
          loginWaiter = null;
        }
        return;
      }
      const turn = ref.current;
      const p = (m.params ?? {}) as Record<string, unknown>;
      switch (m.method) {
        case 'item/agentMessage/delta':
          if (turn && typeof p.delta === 'string') turn.events.push({ t: 'text', text: p.delta, final: false });
          break;
        case 'item/reasoning/textDelta':
          if (turn && typeof p.delta === 'string') turn.events.push({ t: 'thinking', text: p.delta });
          break;
        case 'item/completed': {
          const item = p.item as { type?: string; text?: string; id?: string; command?: string; aggregatedOutput?: string } | undefined;
          if (turn && item?.type === 'agentMessage' && typeof item.text === 'string') {
            turn.open.assistantParts.push(item.text); // TurnRecord 권위본
            turn.events.push({ t: 'text', text: item.text, final: true });
          } else if (turn && item?.type === 'commandExecution') {
            turn.open.toolCalls.push({ tool: 'Shell', arg: toolArgString(item.command ?? item) });
            turn.events.push({
              t: 'tool',
              id: String(item.id ?? ''),
              name: 'Shell',
              input: { command: item.command },
              status: 'done',
              output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 4000) : undefined,
            });
          }
          break;
        }
        case 'thread/tokenUsage/updated': {
          const last = (p.tokenUsage as { last?: { inputTokens?: number; outputTokens?: number } } | undefined)?.last;
          if (turn && last) turn.events.push({ t: 'usage', inputTokens: last.inputTokens ?? 0, outputTokens: last.outputTokens ?? 0 });
          break;
        }
        case 'turn/completed':
          if (turn) {
            turn.open.lastAt = new Date().toISOString();
            const ctx: ReaderCtx = { workspaceId: opts.workspaceId, sessionId: threadId, detail: opts.detail ?? 'compact' };
            void opts.onTurn?.(finalizeTurn(turn.open, 'codex', ctx));
            turn.events.push({ t: 'turn_end', reason: 'completed' });
            turn.events.close();
          }
          break;
        case 'error':
          if (turn) turn.events.push({ t: 'error', message: typeof p.error === 'string' ? p.error : JSON.stringify(p.error) });
          break;
      }
    });

    // 핸드셰이크 + 스레드 시작/이어가기
    await request('initialize', { clientInfo: { name: 'agentbridge', title: null, version: '0' }, capabilities: null });
    notify('initialized', {});
    const startThread = async (): Promise<string> => {
      const r = (await request('thread/start', {
        model: null,
        cwd: opts.cwd,
        approvalPolicy,
        sandbox: 'workspace-write',
        ...(opts.context ? { developerInstructions: opts.context } : {}),
      })) as { thread?: { id?: string } };
      return r?.thread?.id ?? '';
    };
    if (opts.resume) {
      // 기존 스레드 이어가기 — thread/resume({threadId}). 과거 턴(rollout)이 없으면 실패하므로 새 스레드로 폴백.
      try {
        const r = (await request('thread/resume', { threadId: opts.resume })) as { thread?: { id?: string } };
        threadId = r?.thread?.id ?? opts.resume;
      } catch {
        threadId = await startThread();
      }
    } else {
      threadId = await startThread();
    }

    let turnGate: Promise<void> = Promise.resolve();
    const send = (text: string): AsyncIterable<ChatEvent> =>
      (async function* () {
        const prev = turnGate;
        let release!: () => void;
        turnGate = new Promise<void>((r) => (release = r));
        await prev;
        const events = new AsyncQueue<ChatEvent>();
        const open: OpenTurn = { sourceKey: '', user: text, startedAt: new Date().toISOString(), lastAt: '', assistantParts: [], toolCalls: [] };
        const active: ActiveTurn = { events, open, turnId: '' };
        try {
          ref.current = active; // 응답 전에 잡아둠 — 델타가 turn/start 응답보다 먼저 와도 라우팅됨
          events.push({ t: 'session', sessionId: threadId });
          // approvalPolicy·sandboxPolicy·model 오버라이드 = 이번 턴+이후 적용. 권한 모드·모델 전환을 다음 턴에 반영.
          const res = (await request('turn/start', {
            threadId,
            approvalPolicy,
            ...(sandboxPolicy ? { sandboxPolicy } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            input: [{ type: 'text', text, text_elements: [] }],
          })) as { turn?: { id?: string } };
          active.turnId = res?.turn?.id ?? '';
          open.sourceKey = active.turnId; // 턴 고유 키 (deterministicTurnId)
          for await (const ev of events) yield ev;
        } catch (err) {
          yield { t: 'error', message: err instanceof Error ? err.message : String(err) };
        } finally {
          ref.current = null;
          release();
        }
      })();

    return {
      get sessionId() {
        return threadId;
      },
      send,
      async interrupt() {
        const cur = ref.current;
        if (cur) await request('turn/interrupt', { threadId, turnId: cur.turnId }).catch(() => undefined);
      },
      async setPermissionMode(mode) {
        const p = codexPerm(mode, opts.cwd); // 즉시 적용 아님 — 다음 turn/start부터(서버 오버라이드는 턴 단위).
        if (p) { approvalPolicy = p.approvalPolicy; sandboxPolicy = p.sandboxPolicy; }
      },
      async listModels() {
        const res = (await request('model/list', {})) as {
          data?: Array<{ model?: string; displayName?: string; description?: string; hidden?: boolean; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort?: string }> }>;
        };
        return (res?.data ?? [])
          .filter((m) => !m.hidden && m.model)
          .map((m) => ({
            id: m.model as string,
            label: m.displayName ?? (m.model as string),
            desc: m.description,
            current: model ? m.model === model : Boolean(m.isDefault),
            efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((e): e is string => Boolean(e)),
          }));
      },
      async setModel(id) {
        model = id; // 다음 turn/start부터 적용(서버 오버라이드는 턴 단위).
      },
      async setEffort(level) {
        effort = level; // 다음 turn/start.effort부터 적용.
      },
      async setThinking() {
        // codex는 thinking을 effort로 통합 — 별도 토글 없음(no-op).
      },
      async getAccountUsage(): Promise<AccountUsage> {
        // 계정 — account/read: { account: { type:'chatgpt', email, planType }, requiresOpenaiAuth } (라이브 probe 확정).
        const acc = (await request('account/read', {}).catch(() => null)) as { account?: { email?: string; planType?: string } } | null;
        const ai = acc?.account ?? {};
        const plan = ai.planType ? `ChatGPT ${ai.planType.charAt(0).toUpperCase()}${ai.planType.slice(1)}` : undefined;
        const account = { authMethod: 'ChatGPT', email: ai.email, plan };
        // 사용량 한도 — account/rateLimits/read: { rateLimits: { primary, secondary } }. window=5hr/weekly, resetsAt=unix초.
        let limits: UsageLimit[] = [];
        try {
          const rl = (await request('account/rateLimits/read', {})) as { rateLimits?: { primary?: CodexWindow; secondary?: CodexWindow } };
          limits = [rl.rateLimits?.primary, rl.rateLimits?.secondary]
            .filter((w): w is CodexWindow => Boolean(w))
            .map((w) => ({ label: codexWindowLabel(w.windowDurationMins), percent: w.usedPercent ?? 0, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }));
        } catch { /* 미지원/실패 — 계정 정보만 */ }
        return { account, limits }; // codex는 contributors(기여도 분석) 없음
      },
      async listOutputStyles() {
        return { current: '', available: [] }; // codex 미지원(config 기반, 별도 output style 없음)
      },
      async setOutputStyle() {
        // codex 미지원 — no-op
      },
      async listMcpServers(): Promise<McpServerInfo[]> {
        // mcpServerStatus/list: { data: [{ name, serverInfo, tools:{...} }] }
        const r = (await request('mcpServerStatus/list', {}).catch(() => ({}))) as { data?: Array<{ name?: string; tools?: Record<string, unknown> }> };
        return (r.data ?? []).map((s) => ({
          name: s.name ?? '',
          connected: true,
          enabled: true,
          toolCount: s.tools ? Object.keys(s.tools).length : 0,
        }));
      },
      async setMcpServerEnabled() {
        // codex는 런타임 토글 RPC가 없음(config 편집은 3차 보류) — no-op.
      },
      async listAgents(): Promise<AgentInfo[]> {
        // skills/list: { data: [{ cwd, skills: [{ name, description, interface:{displayName}, enabled }] }] }
        const r = (await request('skills/list', {}).catch(() => ({}))) as { data?: Array<{ skills?: Array<{ name?: string; description?: string; interface?: { displayName?: string } }> }> };
        const out: AgentInfo[] = [];
        for (const g of r.data ?? []) for (const s of g.skills ?? []) out.push({ name: s.interface?.displayName ?? s.name ?? '', description: s.description });
        return out;
      },
      async compact() {
        if (!threadId) return false;
        await request('thread/compact/start', { threadId }).catch(() => undefined);
        return true; // codex 공식 압축 RPC
      },
      async listCommands() {
        return []; // codex app-server는 claude식 슬래시 명령 목록 미제공
      },
      respondApproval(id, approve) {
        const rpcReqId = approvals.get(id);
        if (rpcReqId != null) {
          approvals.delete(id);
          write({ jsonrpc: '2.0', id: rpcReqId, result: { decision: approve ? 'approved' : 'denied' } });
        }
      },
      async checkAuth() {
        // account/read로 로그인 여부 추정. 응답 구조 미확정이라 보수적: 에러면 미로그인(false), 응답 있으면 로그인.
        try {
          const a = (await request('account/read', {})) as { account?: unknown; email?: string } | null;
          return Boolean(a && (a.account || a.email));
        } catch {
          return true; // 조회 실패 시 차단하지 않음
        }
      },
      async startLogin(): Promise<LoginChallenge> {
        // chatgpt OAuth — 응답 authUrl을 브라우저로 열면 codex가 콜백 처리→완료 시 account/login/completed 알림.
        const res = (await request('account/login/start', { type: 'chatgpt' })) as { loginId?: string | null; authUrl?: string };
        loginWaiter = null; // 직전 대기 초기화(loginId는 waitLogin이 채움)
        pendingLoginId = res?.loginId ?? null;
        const url = res?.authUrl ?? '';
        return { automaticUrl: url, manualUrl: url };
      },
      waitLogin(): Promise<boolean> {
        // account/login/completed 알림까지 대기(성공 여부 반환).
        return new Promise((resolve) => {
          loginWaiter = { loginId: pendingLoginId, resolve };
        });
      },
      async submitLoginCode() {
        // codex chatgpt 모드는 콜백 코드를 클라가 넘기지 않음(app-server가 자체 콜백 처리) → 미지원.
        return false;
      },
      async end() {
        try {
          child.stdin?.end();
        } catch {
          /* already closed */
        }
        child.kill();
      },
    };
  },
};
