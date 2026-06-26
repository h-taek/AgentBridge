import log from 'electron-log/main'
import { IpcChannel, type CliKind, type TurnsUpdatedEvent } from '@shared/ipc'
import { CaptureManager, maybeAutoNameSession, type TurnsAssistantDetail } from '@agentbridge/core'
import { sendToWorkspaceWindow } from '../windowManager'
import { getCoreCompactionScheduler } from '../compactionScheduler'
import { getCachedSettings } from '../settings'
import { getWorkspacePaths, loadSession, updateSessionMeta } from '../workspaceStore'

// 2026-06-07 M2-4: 턴 기록을 PTY 스크래핑 → transcript 읽기로 전환(설계 §E). 호스트는 CaptureManager에
// 세션을 등록만 하고, 매니저가 각 CLI transcript 파일을 fs.watch/폴링으로 읽어 turns.jsonl을 쌓는다.
// 표시는 PTY가 별도 구동 — 입력/출력 PTY-feed는 기록에 쓰이지 않는다(전부 transcript 파일에서 읽음).
// 호스트 책임:
//   - ptySessionId ↔ sessionId 매핑(onExit는 ptySessionId만 줌, 매니저는 sessionId 키)
//   - codex 비동기 modelSessionId 캡처 시 setCaptureModelSessionId로 매니저에 통지
//   - onTurnFlushed에서 updateSessionMeta(lastChattedAt) + broadcastTurnsUpdated

// M3.6 C — workspaceId 매칭 윈도우에만 전송.
export function broadcastTurnsUpdated(workspaceId: string): void {
  const evt: TurnsUpdatedEvent = { workspaceId }
  sendToWorkspaceWindow(workspaceId, IpcChannel.TurnsUpdated, evt)
}

const manager = new CaptureManager({
  logger: {
    log: (m) => log.info(m),
    warn: (m) => log.warn(m)
  }
})

// onExit가 ptySessionId만 주므로 unregister를 위해 ptySessionId → sessionId 매핑 유지.
const ptyToSession = new Map<string, string>()

// codex 비동기 modelSessionId 캡처가 registerCapture의 async 본문(scheduler await)보다 먼저 도착하면
// 매니저에 아직 세션이 없어 setModelSessionId가 무시될 수 있다 → 캡처가 영영 안 시작. pending에 담아두고
// register 완료 직후 적용해 race를 닫는다.
const pendingModelId = new Map<string, { modelSessionId: string; cwd: string }>()

export function registerCapture(args: {
  workspaceId: string
  sessionId: string
  ptySessionId: string
  model: CliKind
  workspacePath: string
  modelSessionId?: string | null
}): void {
  const workspaceRoot = getWorkspacePaths(args.workspaceId).dir
  ptyToSession.set(args.ptySessionId, args.sessionId)
  void (async (): Promise<void> => {
    try {
      // getCoreCompactionScheduler가 내부에서 loadSettings를 await — 이 시점에 settings cache가 채워짐.
      // 약간 늦게 register돼도 매니저는 transcript를 offset 0부터 읽어 그동안 쌓인 턴까지 잡으므로 유실 없음.
      const scheduler = await getCoreCompactionScheduler()
      manager.register({
        workspaceId: args.workspaceId,
        workspaceRoot,
        workspacePath: args.workspacePath,
        sessionId: args.sessionId,
        model: args.model,
        modelSessionId: args.modelSessionId ?? null,
        cwd: args.workspacePath,
        getDetail: () => getCachedSettings().turnsAssistantDetail as TurnsAssistantDetail,
        scheduler,
        onTurnFlushed: async ({ workspaceId, sessionId, flushedAt }) => {
          try {
            await updateSessionMeta(workspaceId, sessionId, { lastChattedAt: flushedAt })
          } catch (err) {
            log.warn('CaptureManager lastChattedAt 갱신 실패 (non-fatal)', {
              workspaceId,
              sessionId,
              err: String(err)
            })
          }
          // 자동 세션 이름 — 첫 nameable 턴으로 1회 명명(기존 title 보호). 실패는 무시.
          try {
            await maybeAutoNameSession({
              workspaceRoot,
              sessionId,
              getCurrentTitle: async () => (await loadSession(workspaceId, sessionId)).title,
              setTitle: async (title) => {
                await updateSessionMeta(workspaceId, sessionId, { title })
              }
            })
          } catch (err) {
            log.warn('자동 세션 이름 실패 (non-fatal)', {
              workspaceId,
              sessionId,
              err: String(err)
            })
          }
          broadcastTurnsUpdated(workspaceId)
        }
      })
      // register 전에 도착한 modelSessionId 캡처가 있으면 지금 적용 (codex race 가드).
      const pending = pendingModelId.get(args.sessionId)
      if (pending) {
        pendingModelId.delete(args.sessionId)
        manager.setModelSessionId(args.sessionId, pending.modelSessionId, pending.cwd)
      }
      log.info('CaptureManager registered', {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        ptySessionId: args.ptySessionId,
        model: args.model,
        modelSessionId: args.modelSessionId ?? null
      })
    } catch (err) {
      ptyToSession.delete(args.ptySessionId)
      log.warn('CaptureManager register 실패', {
        ptySessionId: args.ptySessionId,
        err: String(err)
      })
    }
  })()
}

// codex/agy 비동기 modelSessionId 캡처 시 호출 — 매니저가 그때 경로를 해석해 캡처 시작.
export function setCaptureModelSessionId(
  sessionId: string,
  modelSessionId: string,
  cwd: string
): void {
  // register가 이미 끝났으면 즉시 적용, 아직이면 pending에 담아 register 완료 시 적용(둘 다 호출 — 멱등).
  pendingModelId.set(sessionId, { modelSessionId, cwd })
  manager.setModelSessionId(sessionId, modelSessionId, cwd)
}

export function unregisterCapture(ptySessionId: string): void {
  const sessionId = ptyToSession.get(ptySessionId)
  if (!sessionId) return
  ptyToSession.delete(ptySessionId)
  pendingModelId.delete(sessionId)
  void manager.unregister(sessionId).catch((err) => {
    log.warn('CaptureManager unregister 실패', { ptySessionId, sessionId, err: String(err) })
  })
}

// 앱 종료(before-quit) 시 모든 세션의 마지막 열린 턴을 flush 완료까지 await (V-07 동작 보존).
export async function disposeAndFlushAll(): Promise<void> {
  ptyToSession.clear()
  pendingModelId.clear()
  await manager.disposeAll()
}
