import type { CliKind } from '@shared/ipc'
import { claudeAdapter } from './claudeAdapter'
import { codexAdapter } from './codexAdapter'
import { agyAdapter } from './agyAdapter'
import type { CLIAdapter } from './types'

// 모델별 어댑터 라우팅 — 2026 agy(Antigravity) 리브랜드로 gemini → agy 어댑터 교체.
const adapters: Partial<Record<CliKind, CLIAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter
}

export function getAdapter(kind: CliKind): CLIAdapter {
  const a = adapters[kind]
  if (!a) {
    throw new Error(`CLIAdapter 미구현: ${kind}`)
  }
  return a
}

export type {
  CLIAdapter,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult
} from './types'
