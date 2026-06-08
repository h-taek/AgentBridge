import log from 'electron-log/main'
import type { CliKind, CliPresence, EnvProbeResult } from '@shared/ipc'
import { createEnvProbe, type EnvProbe } from '@agentbridge/core'

// 코어 envProbe wrapper — login shell 캡처 + cli 탐색 + version 캐싱은 코어가 처리.
// 외부 API(probeEnvOnce/getCliPath/getShellPath/getCachedEnv)와 EnvProbeResult shape는 그대로 유지.

const CLI_KINDS: CliKind[] = ['claude', 'codex', 'agy']

let coreProbe: EnvProbe | null = null
function getCoreProbe(): EnvProbe {
  if (!coreProbe) {
    coreProbe = createEnvProbe({
      logger: {
        log: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg)
      },
      probeVersion: true
    })
  }
  return coreProbe
}

export async function probeEnv(): Promise<EnvProbeResult> {
  const probe = getCoreProbe()
  const capturedAt = new Date().toISOString()
  const shellPath = probe.getShellEnv().PATH ?? process.env.PATH ?? ''

  const clis: CliPresence[] = CLI_KINDS.map((kind): CliPresence => {
    const r = probe.probe(kind)
    if (!r.found || !r.resolvedPath) {
      return { kind, found: false }
    }
    return {
      kind,
      found: true,
      path: r.resolvedPath,
      version: r.version,
      error: r.versionError
    }
  })

  return {
    shellPath,
    clis,
    capturedAt
  }
}

// 캐시 — main 부팅 시 1회 채워지고 어댑터/IPC 핸들러가 동기 조회.
// 사용자가 CLI를 새로 설치해 강제 갱신이 필요하면 forceRefresh=true 전달.
let cached: EnvProbeResult | null = null
let inflight: Promise<EnvProbeResult> | null = null

export async function probeEnvOnce(forceRefresh = false): Promise<EnvProbeResult> {
  if (!forceRefresh && cached) return cached
  if (!forceRefresh && inflight) return inflight
  if (forceRefresh) {
    // 코어 캐시도 함께 무효화하기 위해 인스턴스 재생성.
    coreProbe = null
  }
  inflight = probeEnv().then((r) => {
    cached = r
    inflight = null
    return r
  })
  return inflight
}

export function getCachedEnv(): EnvProbeResult | null {
  return cached
}

export function getCliPath(kind: CliKind): string | undefined {
  return cached?.clis.find((c) => c.kind === kind && c.found)?.path
}

export function getShellPath(): string {
  return cached?.shellPath ?? process.env.PATH ?? ''
}

// 코어 모듈(refineDispatcher 등)이 EnvProbe 인스턴스를 직접 받을 수 있도록 노출.
export function getCoreEnvProbe(): EnvProbe {
  return getCoreProbe()
}
