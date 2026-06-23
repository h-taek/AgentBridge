// agy 어댑터 — localharness(Antigravity 엔진)를 claude/codex와 동일한 AgentAdapter로 정규화.
// 전송층은 localharness 클라이언트(spawn+부트스트랩+WS+JSON, ./localharness/client). codex와 같은 결로
// createSerialTurnSession 골격을 재사용하고, OutputEvent(JSON)→ChatEvent 매핑 + finalizeTurn/onTurn으로
// TurnRecord를 방출한다. 인증=사용자 Gemini API 키(process.env.GEMINI_API_KEY) → HarnessConfig.models[].apiKey.
//
// 프로토콜(antigravity-sdk-python local_connection.py 정독): InputEvent{userInput} 전송 →
//   OutputEvent 스트림: stepUpdate(textDelta/thinkingDelta/text(STATE_DONE)/액션/toolConfirmationRequest/error),
//   trajectoryStateUpdate(부모 STATE_IDLE = 턴 종료). 부모 trajectory = cascadeId.
import type { ReaderCtx } from '../transcriptReader/types.js';
import { finalizeTurn, toolArgString } from '../transcriptReader/util.js';
import { createSerialTurnSession, type ActiveTurn } from './createSerialTurnSession.js';
import { startHarness, type HarnessClient } from './localharness/client.js';
import type { AccountUsage, AgentAdapter, AgentInfo, LoginChallenge, McpServerInfo, ModelOption, PermissionMode, Session, StartOptions } from './types.js';

const DEFAULT_MODEL = 'gemini-3.5-flash';

// stepUpdate 액션 서브필드(oneof) → 표시용 도구 이름.
const ACTION_TOOLS: Record<string, string> = {
  runCommand: 'Shell', listDirectory: 'ListDir', findFile: 'FindFile', searchDirectory: 'Grep',
  viewFile: 'ViewFile', createFile: 'CreateFile', editFile: 'EditFile', generateImage: 'GenerateImage',
  searchWeb: 'SearchWeb', mcpTool: 'McpTool', invokeSubagent: 'Subagent',
};

export const agyAdapter: AgentAdapter = {
  id: 'agy',
  async start(opts: StartOptions): Promise<Session> {
    const apiKey = process.env.GEMINI_API_KEY ?? '';
    let model = DEFAULT_MODEL;

    // 진행 중인 턴 슬롯(직렬). client.onEvent가 ref.current.events로 ChatEvent 라우팅. (codex rl.on과 동형)
    const ref: { current: ActiveTurn | null } = { current: null };
    let cascadeId = ''; // 대화 id (resume·session 이벤트용)
    let turnSeq = 0; // 턴별 고유 sourceKey 생성용 — agy는 trajectoryId가 대화 단위라 턴 키로 못 씀(dedup 충돌 방지)
    const approvalPos = new Map<string, { trajectoryId: string; stepIndex: number }>(); // approval id → 위치(응답용)
    const toolSteps = new Map<string, 'started' | 'done'>(); // 도구 stepKey 디듀프(하니스가 한 도구에 stepUpdate 다수 전송)

    const client: HarnessClient = await startHarness({ apiKey, model, cwd: opts.cwd, context: opts.context });

    client.onEvent((ev) => {
      const icr = ev.initializeConversationResponse as { cascadeId?: string } | undefined;
      if (icr?.cascadeId) cascadeId = icr.cascadeId;

      const turn = ref.current;
      const su = ev.stepUpdate as Record<string, unknown> | undefined;
      if (su) {
        if (typeof su.cascadeId === 'string' && su.cascadeId && !cascadeId) cascadeId = su.cascadeId;
        if (!turn) return;
        const trajId = typeof su.trajectoryId === 'string' ? su.trajectoryId : '';
        if (typeof su.textDelta === 'string' && su.textDelta) turn.events.push({ t: 'text', text: su.textDelta, final: false });
        if (typeof su.thinkingDelta === 'string' && su.thinkingDelta) turn.events.push({ t: 'thinking', text: su.thinkingDelta });
        // 완결 assistant 메시지 = TurnRecord 권위본(델타 아님). agy는 스텝마다 text를 내므로 스텝별로 본문 파트가 된다.
        // 패널은 final:true마다 텍스트 블록을 닫아 별개 블록으로 렌더 → 도구 행과 자연히 분리(codex 멀티 agentMessage와 동형).
        // IR은 assistantParts.join('\n')로 합쳐진다. (액션 스텝 text도 모델 서술이라 보존 — 필터하면 본문이 비는 턴 발생.)
        if (su.state === 'STATE_DONE' && su.source === 'SOURCE_MODEL' && typeof su.text === 'string' && su.text) {
          turn.open.assistantParts.push(su.text);
          turn.events.push({ t: 'text', text: su.text, final: true });
        }
        // 액션(도구) — oneof 서브필드 탐지. 하니스가 한 도구에 stepUpdate를 여러 번 보내므로 stepKey로 디듀프(started 1회·done 1회).
        for (const k of Object.keys(ACTION_TOOLS)) {
          if (su[k]) {
            const stepKey = `${trajId}:${String(su.stepIndex ?? 0)}`;
            const isDone = su.state === 'STATE_DONE';
            const prev = toolSteps.get(stepKey);
            if (!prev) {
              toolSteps.set(stepKey, isDone ? 'done' : 'started');
              turn.open.toolCalls.push({ tool: ACTION_TOOLS[k], arg: toolArgString(su[k]) }); // TurnRecord엔 1회만
              turn.events.push({ t: 'tool', id: stepKey, name: ACTION_TOOLS[k], input: su[k], status: isDone ? 'done' : 'started' });
            } else if (isDone && prev !== 'done') {
              toolSteps.set(stepKey, 'done');
              turn.events.push({ t: 'tool', id: stepKey, name: ACTION_TOOLS[k], input: su[k], status: 'done' });
            }
            break; // oneof — 하나만 매칭
          }
        }
        // 빌트인 도구 승인 요청(STATE_WAITING_FOR_USER).
        const tcr = su.toolConfirmationRequest as Record<string, unknown> | undefined;
        if (tcr) {
          const id = `${trajId}:${String(su.stepIndex ?? 0)}`;
          approvalPos.set(id, { trajectoryId: trajId, stepIndex: Number(su.stepIndex ?? 0) });
          turn.events.push({ t: 'approval', id, title: '도구 실행 승인', detail: JSON.stringify(tcr).slice(0, 300), tool: typeof tcr.toolName === 'string' ? tcr.toolName : 'tool' });
        }
        const err = su.error as { errorMessage?: string } | undefined;
        if (err) turn.events.push({ t: 'error', message: err.errorMessage ?? JSON.stringify(err) });
        return;
      }
      const tsu = ev.trajectoryStateUpdate as { state?: string; trajectoryId?: string } | undefined;
      if (tsu && turn) {
        // 부모 trajectory(=cascadeId)가 IDLE = 턴 종료. cascadeId 미상이면 첫 IDLE로 폴백.
        const isParent = !cascadeId || !tsu.trajectoryId || tsu.trajectoryId === cascadeId;
        if (tsu.state === 'STATE_IDLE' && isParent) {
          turn.open.lastAt = new Date().toISOString();
          const ctx: ReaderCtx = { workspaceId: opts.workspaceId, sessionId: cascadeId, detail: opts.detail ?? 'compact' };
          void opts.onTurn?.(finalizeTurn(turn.open, 'agy', ctx));
          turn.events.push({ t: 'turn_end', reason: 'completed' });
          turn.events.close();
        }
        return;
      }
      if (ev.error && turn) turn.events.push({ t: 'error', message: typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error) });
    });

    // 턴 직렬 골격 공유. begin=agy 턴 시작(InputEvent 전송). ref는 begin 전에 세팅돼 델타가 먼저 와도 라우팅됨.
    const send = createSerialTurnSession(ref, (active, text) => {
      active.open.sourceKey = `t${++turnSeq}`; // 턴별 고유 키(begin은 이벤트보다 먼저 실행돼 항상 세팅됨)
      toolSteps.clear(); // 새 턴 — 도구 디듀프 상태 리셋
      if (cascadeId) active.events.push({ t: 'session', sessionId: cascadeId, model });
      client.sendInput(text);
    });

    return {
      get sessionId() {
        return cascadeId;
      },
      send,
      async interrupt() {
        client.sendEvent({ haltRequest: true });
      },
      async setPermissionMode(_mode: PermissionMode) {
        // agy PermissionsConfig는 init(HarnessConfig) 단위 — 런타임 토글은 v1 미지원(no-op).
      },
      async listModels(): Promise<ModelOption[]> {
        // 모델 전환은 재init이 필요해 v1은 단일 모델만 노출.
        return [{ id: DEFAULT_MODEL, label: 'Gemini 3.5 Flash', current: model === DEFAULT_MODEL, efforts: [] }];
      },
      async setModel(id: string) {
        model = id; // 적용은 재init 필요 — v1 표시만.
      },
      async setEffort() {
        /* agy thinkingLevel은 init 단위 — v1 no-op */
      },
      async setThinking() {
        /* v1 no-op */
      },
      async getAccountUsage(): Promise<AccountUsage> {
        return { account: { authMethod: 'Gemini API key' }, limits: [] }; // agy=API 키 — account/usage RPC 없음
      },
      async listOutputStyles() {
        return { current: '', available: [] };
      },
      async setOutputStyle() {
        /* 미지원 */
      },
      async listMcpServers(): Promise<McpServerInfo[]> {
        return []; // v1은 mcp_servers 미주입
      },
      async setMcpServerEnabled() {
        /* 미지원 */
      },
      async listAgents(): Promise<AgentInfo[]> {
        return [];
      },
      async compact() {
        return false; // agy 압축은 액션 기반 — 명시 RPC 없음(v1)
      },
      async listCommands() {
        return [];
      },
      async suggestTitle() {
        return null;
      },
      respondApproval(id, approve) {
        const pos = approvalPos.get(id);
        if (pos) {
          approvalPos.delete(id);
          client.sendEvent({ toolConfirmation: { trajectoryId: pos.trajectoryId, stepIndex: pos.stepIndex, accepted: approve } });
        }
      },
      async checkAuth() {
        return Boolean(process.env.GEMINI_API_KEY); // agy=API 키 — 키 존재 = 인증 가능
      },
      async startLogin(): Promise<LoginChallenge> {
        return { automaticUrl: '', manualUrl: '' }; // agy는 OAuth 로그인 없음(API 키)
      },
      async waitLogin() {
        return false;
      },
      async submitLoginCode() {
        return false;
      },
      async end() {
        client.end();
      },
    };
  },
};
