import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import log from 'electron-log/main'

// Codex `thread_id` 캡처 모듈.
//
// 배경 (probe_results §4):
// - codex 인터랙티브 PTY 모드는 stream-json을 출력하지 않음 → `thread.started.thread_id`를
//   PTY 표준출력에서 잡을 수 없다.
// - codex CLI는 세션을 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<UUID>.jsonl`로
//   영속화한다. 파일명 끝의 UUID가 thread_id.
// - 따라서 spawn 직전 디렉토리 스냅샷을 잡고, spawn 후 polling으로 새로 생긴 jsonl을
//   감지해 파일명에서 thread_id를 추출한다.
//
// 휴리스틱 한계:
// - 같은 머신에서 다른 codex 인스턴스가 *동시에* 새 세션을 만들면 두 후보가 동시에 등장 가능.
//   현실적 빈도가 낮고(1인 워크스테이션) 시점 매칭이 가깝다는 가정. 충돌 시 가장 먼저 발견된
//   파일을 우리 세션으로 간주한다(architecture §13.2 명시 risk).
// - codex가 세션 파일을 만드는 시점은 trust 다이얼로그 응답 *후*가 일반적이라 사용자가 trust를
//   응답할 때까지 캡처 대기. timeout(default 60s) 동안 발견 못 하면 실패.

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions')

// rollout-<ISO>-<UUID>.jsonl. UUID는 8-4-4-4-12.
const ROLLOUT_FILE_RE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

export type CodexSessionSnapshot = {
  // 스냅샷 시점에 존재한 모든 rollout jsonl 파일의 절대경로 set.
  files: Set<string>
}

// 모든 jsonl 파일을 walk. 디렉토리 누락(첫 사용 등)은 빈 set.
async function walkRolloutFiles(): Promise<Set<string>> {
  const out = new Set<string>()
  let years: string[] = []
  try {
    years = await fs.readdir(CODEX_SESSIONS_ROOT)
  } catch {
    return out
  }
  for (const y of years) {
    const yp = path.join(CODEX_SESSIONS_ROOT, y)
    let months: string[] = []
    try {
      months = await fs.readdir(yp)
    } catch {
      continue
    }
    for (const m of months) {
      const mp = path.join(yp, m)
      let days: string[] = []
      try {
        days = await fs.readdir(mp)
      } catch {
        continue
      }
      for (const d of days) {
        const dp = path.join(mp, d)
        let entries: string[] = []
        try {
          entries = await fs.readdir(dp)
        } catch {
          continue
        }
        for (const e of entries) {
          if (e.endsWith('.jsonl') && ROLLOUT_FILE_RE.test(e)) {
            out.add(path.join(dp, e))
          }
        }
      }
    }
  }
  return out
}

// spawn 직전 호출 — 현재 존재하는 jsonl 파일 set을 캡처.
export async function snapshotCodexSessions(): Promise<CodexSessionSnapshot> {
  const files = await walkRolloutFiles()
  return { files }
}

export type CaptureOptions = {
  // polling 주기. 기본 1000ms.
  intervalMs?: number
  // 전체 timeout. 기본 60s — 사용자가 trust dialog 응답할 시간 포함.
  timeoutMs?: number
  // AbortSignal. spawn 실패·취소 시 폴링 중단.
  signal?: AbortSignal
}

// snapshot 이후 새로 생긴 rollout jsonl을 polling으로 감지.
// 발견 시 파일명에서 thread_id 추출해 resolve. timeout/abort면 reject.
export async function captureNewThreadId(
  before: CodexSessionSnapshot,
  opts: CaptureOptions = {}
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 60_000
  const start = Date.now()
  while (true) {
    if (opts.signal?.aborted) {
      throw new Error('codex thread_id capture aborted')
    }
    const now = await walkRolloutFiles()
    for (const f of now) {
      if (!before.files.has(f)) {
        const base = path.basename(f)
        const m = ROLLOUT_FILE_RE.exec(base)
        if (m) {
          log.info('codex thread_id captured', { file: f, threadId: m[1] })
          return m[1]
        }
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `codex thread_id capture timeout (${timeoutMs}ms) — ~/.codex/sessions에 새 jsonl 미감지. trust 다이얼로그가 응답되지 않았거나 codex가 비정상 종료됐을 수 있다.`
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}
