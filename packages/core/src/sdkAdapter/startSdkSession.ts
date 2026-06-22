// startSdkSession — SDK 채팅 한 판의 셋업 시퀀스를 코어 한 곳에 모은다:
//   hook 설치 → IR 씨드 → SdkCapture 생성·배선(onTurn→accept) → adapter.start.
// 호스트(익스텐션·데스크탑)는 결속(adapter·scheduler·hookInstaller·workspaceRoot·detail)만 주입하고 이 함수를
// 호출 — 데스크탑 배선 시 패널 시작 로직을 복붙하지 않게. 소유권·화면·세션id 영속은 호스트 facade에 남는다.
//
// PTY 대조: 이 "adapter↔capture 연결"은 PTY에선 CaptureManager가 내부에서 숨겨 했지만(호스트는 register 한 번),
// SDK엔 그 매니저가 없어 연결이 패널에 노출돼 있었다 → 노출된 셋업만 함수로 추출(매니저 클래스 아님).
import type { CliKind } from '../shared/cli.js';
import type { IR } from '../shared/ir.js';
import type { TurnsAssistantDetail } from '../shared/turns.js';
import type { HookInstaller } from '../hookInstaller.js';
import type { CaptureSchedulerLike } from '../transcriptReader/manager.js';
import type { Logger } from '../interfaces.js';
import { noopLogger } from '../interfaces.js';
import { readIR } from '../irStore.js';
import { SdkCapture } from './sdkCapture.js';
import type { AgentAdapter, Session } from './types.js';

// 이전 세션 IR을 어댑터 context 텍스트(JSON 블록)로 렌더. compaction의 IR 주입과 동형.
export function formatIRContext(ir: IR | null): string | undefined {
  if (!ir) return undefined;
  const body = {
    intent: ir.intent,
    decisions: ir.decisions,
    files: ir.files,
    commands: ir.commands,
    tests: ir.tests,
    pending: ir.pending,
  };
  return (
    '# 이전 세션 인계 (AgentBridge IR)\n\n다음은 이전 대화에서 압축된 작업 맥락이다. 이어서 돕는다.\n\n' +
    '```json\n' + JSON.stringify(body, null, 2) + '\n```'
  );
}

export interface StartSdkSessionOptions {
  adapter: AgentAdapter;
  model: CliKind;
  cwd: string;            // 사용자 프로젝트 cwd
  workspaceId: string;
  workspaceRoot: string;  // 세션 스토리지 루트(IR·turns·claude 격리 settings)
  scheduler: CaptureSchedulerLike;
  hookInstaller: HookInstaller;
  detail: TurnsAssistantDetail;
  injectContext: boolean; // false=클린 슬레이트(/clear) — 이전 IR 미주입
  resume?: string;        // 이전 modelSessionId 이어가기(미지정=새 세션)
  logger?: Logger;
}

export interface StartedSdkSession {
  session: Session;
  capture: SdkCapture;
  // 이전 IR이 있었는지(UI 'injected' 배지용). 실제 매 턴 주입은 설치된 UserPromptSubmit 훅이 담당.
  context: string | undefined;
}

export async function startSdkSession(opts: StartSdkSessionOptions): Promise<StartedSdkSession> {
  const log = opts.logger ?? noopLogger;

  // 매 턴 컨텍스트 주입은 설치된 UserPromptSubmit 훅이 담당 — PTY CLI와 동일 installer 재사용(새 메커니즘 0).
  //   claude: 격리 settings 파일을 SDK `settings` 옵션(=CLI --settings)으로 로드 / codex: cwd/.codex 자동.
  let settingsFile: string | undefined;
  try {
    if (opts.model === 'claude') {
      settingsFile = await opts.hookInstaller.installClaudeHooks(opts.workspaceRoot, opts.workspaceId);
    } else if (opts.model === 'codex') {
      await opts.hookInstaller.installCodexHooks(opts.cwd, opts.workspaceId);
    }
  } catch (err) {
    log.warn(`startSdkSession: hook 설치 실패 — ${err instanceof Error ? err.message : String(err)}`);
  }

  const ir = opts.injectContext ? await readIR(opts.workspaceRoot) : null;
  const context = formatIRContext(ir);

  const capture = new SdkCapture({
    workspaceId: opts.workspaceId,
    workspaceRoot: opts.workspaceRoot,
    workspacePath: opts.cwd,
    model: opts.model,
    scheduler: opts.scheduler,
  });

  const session = await opts.adapter.start({
    cwd: opts.cwd,
    workspaceId: opts.workspaceId,
    detail: opts.detail,
    // IR 주입은 매 턴 훅이 담당 → 시작 시 1회 systemPrompt 주입은 제거(중복).
    ...(settingsFile ? { settings: settingsFile } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    onTurn: (turn) => capture.accept(turn),
  });

  return { session, capture, context };
}
