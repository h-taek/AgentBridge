import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import log from 'electron-log/main'
import {
  IpcChannel,
  type AttachFileAccepted,
  type AttachFileRejected,
  type AttachFilesRequest,
  type AttachFilesResult
} from '@shared/ipc'
import { getActiveSession } from '../modules/sessionActive'
import { writePty } from '../modules/ptySession'
import { loadWorkspace } from '../modules/workspaceStore'
import { getWorkspaceIdByWindow } from '../modules/windowManager'

// M3.6 B — 드래그 앤 드롭 파일 첨부.
//
// renderer가 xterm 영역에 OS 파일을 드롭하면 절대 경로 배열을 이 핸들러로 보낸다.
// 각 경로를 stat 검증 후 활성 PTY에 paste only (Enter 안 함):
//   cli   — 절대 경로 줄바꿈 분리, **bracketed paste sequence**(\x1b[200~...\x1b[201~)로 감쌈
//           → TUI가 "paste 중"으로 인식해 \n을 submit 트리거가 아닌 입력 박스 내부 줄바꿈으로 처리.
//             codex(Rust TUI) / gemini(Ink readline)의 자동 submit 회피 핵심.
//   shell — 절대 경로 quoted, 공백 분리, 끝에 공백 1개. \n 안 붙임 (shell에선 \n=Enter=명령 실행).
//
// 사용자가 paste 후 자유롭게 메시지를 추가하고 직접 Enter로 submit. prefix 강제 X.
//
// 디렉토리는 첫 cut에서 거부 (Phase 2에서 트리 인덱싱).
//
// 경로 정책: cwd 안/밖 무차별 절대 경로 허용 — 외부 파일도 paste 가능.
//   근거 (M3.7 검증 라운드 D-5에서 옵션 C로 확정):
//     1) 드래그 앤 드롭은 사용자 의도가 명시된 액션 (renderer 단독 트리거 불가).
//     2) 자동 submit이 bracketed paste / shell 분기 양쪽 모두에서 차단되어 있어,
//        renderer XSS만으로는 exfil 불가 — 사용자 Enter 한 번이 추가로 필요.
//     3) 옵션 A(cwd 밖 차단)는 "데스크탑 스크린샷을 모델에 보여주기" 등 정상 UX를 깸.
//     4) 옵션 B(외부 파일 확인 모달)는 클릭 피로 + 구현 비용 대비 효용 낮음.
//   따라서 본 핸들러는 절대 경로 + stat 검증까지만 수행하고, prefix allowlist는 두지 않는다.

const MAX_PATHS_PER_DROP = 20

async function statFile(
  absolutePath: string
): Promise<{ ok: true; sizeBytes: number } | { ok: false; reason: string }> {
  try {
    const st = await fs.stat(absolutePath)
    if (st.isDirectory()) return { ok: false, reason: '디렉토리는 아직 지원 안 함' }
    if (!st.isFile()) return { ok: false, reason: '일반 파일이 아님' }
    return { ok: true, sizeBytes: st.size }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: '파일 없음' }
    if (code === 'EACCES') return { ok: false, reason: '권한 없음' }
    return { ok: false, reason: String(err) }
  }
}

// zsh quoting — 공백/특수문자 있을 때만 작은따옴표로 감싼다.
function shellQuoteIfNeeded(p: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(p)) return p
  return `'${p.replace(/'/g, `'\\''`)}'`
}

async function handleAttachFiles(
  event: IpcMainInvokeEvent,
  req: AttachFilesRequest
): Promise<AttachFilesResult> {
  // sender 소유권 가드 — req.workspaceId가 sender 윈도우의 claim workspace와 일치해야 함.
  // 한 워크스페이스 = 한 윈도우 정책상 임의 윈도우가 다른 워크스페이스 세션에 attach 못 함.
  const win = BrowserWindow.fromWebContents(event.sender)
  const senderWorkspaceId = win ? getWorkspaceIdByWindow(win) : null
  if (senderWorkspaceId !== req.workspaceId) {
    log.warn('attach:files 거부 — sender 소유권 불일치', {
      workspaceId: req.workspaceId,
      senderWorkspaceId
    })
    return { ok: false, accepted: [], rejected: [], error: 'sender 소유권 불일치' }
  }

  log.info('attach:files', {
    workspaceId: req.workspaceId,
    sessionId: req.sessionId,
    count: req.paths.length
  })

  if (!Array.isArray(req.paths) || req.paths.length === 0) {
    return { ok: false, accepted: [], rejected: [], error: '경로 비어있음' }
  }
  if (req.paths.length > MAX_PATHS_PER_DROP) {
    return {
      ok: false,
      accepted: [],
      rejected: [],
      error: `한 번에 최대 ${MAX_PATHS_PER_DROP}개까지 첨부 가능`
    }
  }

  // 세션 활성 확인 — 비활성이면 PTY 없음.
  const activeSess = getActiveSession(req.workspaceId, req.sessionId)
  if (!activeSess) {
    return { ok: false, accepted: [], rejected: [], error: '활성 세션 없음' }
  }

  // 세션 메타 — cli/shell kind 판별.
  let ws
  try {
    ws = await loadWorkspace(req.workspaceId)
  } catch (err) {
    return {
      ok: false,
      accepted: [],
      rejected: [],
      error: `워크스페이스 로드 실패: ${String(err)}`
    }
  }
  const sessionMeta = ws.sessions.find((s) => s.sessionId === req.sessionId)
  if (!sessionMeta) {
    return { ok: false, accepted: [], rejected: [], error: '세션 메타 없음' }
  }
  const kind = sessionMeta.kind ?? 'cli'

  // 각 경로 stat 검증
  const accepted: AttachFileAccepted[] = []
  const rejected: AttachFileRejected[] = []
  for (const p of req.paths) {
    if (typeof p !== 'string' || p.length === 0) {
      rejected.push({ path: String(p), reason: '경로가 문자열이 아님' })
      continue
    }
    // 절대 경로만 허용 — renderer가 webUtils.getPathForFile로 추출하므로 항상 절대.
    if (!p.startsWith('/')) {
      rejected.push({ path: p, reason: '절대 경로 아님' })
      continue
    }
    const st = await statFile(p)
    if (!st.ok) {
      rejected.push({ path: p, reason: st.reason })
      continue
    }
    accepted.push({ path: p, sizeBytes: st.sizeBytes })
  }

  if (accepted.length === 0) {
    return { ok: false, accepted, rejected, error: '첨부 가능한 파일 없음' }
  }

  // PTY inject — cli/shell 둘 다 Enter 없이 paste.
  //   cli   → bracketed paste(\x1b[200~ ... \x1b[201~)로 감싼 `"@<절대경로>"` 공백 분리, 끝에 공백 1개.
  //           bracketed paste 모드 = TUI가 "paste"로 인식 → codex/gemini의 자동 submit 차단.
  //           양쪽 큰따옴표 = 공백 포함 경로 단일 토큰 보장 + 시각 명확성.
  //   shell → 절대 경로 quoted 공백 분리. \n 안 붙임 (shell에선 \n = 명령 실행).
  //
  // Unicode NFC 정규화 — macOS 파일시스템은 한글 등 결합 자모를 NFD(분리형)로 저장하고
  // `webUtils.getPathForFile`도 NFD 그대로 반환한다. Gemini의 Ink readline 입력 박스가
  // 결합 자모를 합쳐 렌더하지 못해 초성만 표시되는 버그가 발생. PTY 송신 시점에 NFC로
  // 정규화하면 모델 입력 박스에서 정상 표시된다. fs.stat 검증은 NFD 원본으로 이미 통과했고,
  // APFS는 unicode-normalization-insensitive라 모델이 NFC 경로로 파일을 다시 열어도 OK.
  // ASCII 파일명은 NFC=NFD 동치라 무영향.
  const toNfc = (s: string): string => s.normalize('NFC')
  try {
    if (kind === 'shell') {
      const text = accepted.map((a) => shellQuoteIfNeeded(toNfc(a.path))).join(' ') + ' '
      writePty(activeSess.ptySessionId, text)
    } else {
      const body = accepted.map((a) => `"@${toNfc(a.path)}"`).join(' ') + ' '
      const wrapped = `\x1b[200~${body}\x1b[201~`
      writePty(activeSess.ptySessionId, wrapped)
    }
  } catch (err) {
    log.warn('attach:files — PTY write 실패', {
      workspaceId: req.workspaceId,
      sessionId: req.sessionId,
      err: String(err)
    })
    return {
      ok: false,
      accepted,
      rejected,
      error: `PTY write 실패: ${String(err)}`
    }
  }

  log.info('attach:files — done', {
    workspaceId: req.workspaceId,
    sessionId: req.sessionId,
    kind,
    accepted: accepted.length,
    rejected: rejected.length
  })

  return { ok: true, accepted, rejected }
}

export function registerAttachHandlers(): void {
  ipcMain.handle(IpcChannel.AttachFiles, handleAttachFiles)
}
