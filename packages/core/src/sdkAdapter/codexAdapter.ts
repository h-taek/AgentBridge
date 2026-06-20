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
import type { AgentAdapter, ChatEvent, PermissionMode, Session, StartOptions } from './types.js';

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

    // 핸드셰이크 + 스레드 시작
    await request('initialize', { clientInfo: { name: 'agentbridge', title: null, version: '0' }, capabilities: null });
    notify('initialized', {});
    const startRes = (await request('thread/start', {
      model: null,
      cwd: opts.cwd,
      approvalPolicy,
      sandbox: 'workspace-write',
      ...(opts.context ? { developerInstructions: opts.context } : {}),
    })) as { thread?: { id?: string } };
    threadId = startRes?.thread?.id ?? threadId;

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
          data?: Array<{ model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort?: string }> }>;
        };
        return (res?.data ?? [])
          .filter((m) => !m.hidden && m.model)
          .map((m) => ({
            id: m.model as string,
            label: m.displayName ?? (m.model as string),
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
      respondApproval(id, approve) {
        const rpcReqId = approvals.get(id);
        if (rpcReqId != null) {
          approvals.delete(id);
          write({ jsonrpc: '2.0', id: rpcReqId, result: { decision: approve ? 'approved' : 'denied' } });
        }
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
