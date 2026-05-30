import { app } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import log from 'electron-log/main'
import type {
  AppSettings,
  CliKind,
  LanguageCode,
  RefineModelPolicy,
  ThemeMode,
  TurnsAssistantDetail
} from '@shared/ipc'

// AppSettings — M3 N 청크. architecture §14.7.
//
// 사용자 글로벌 설정. 영속 위치: `~/Library/Application Support/AgentBridge/settings.json`.
// 워크스페이스 단위가 아닌 *앱 단위* 설정 — 워크스페이스 전환 시에도 유지.
//
// 현재 다루는 항목 (M3 N):
//   - refineModel: refine LLM 선택 정책 (auto/agy-flash/active/off)
//
// 후속 청크에서 추가될 가능성:
//   - compactionTriggerN / compactionTriggerTokens (O 청크)
//   - maxConcurrentSessions (UX cap)
//   - 사용자 명시 helper binary path override (M4 패키징)

const SETTINGS_FILE_NAME = 'settings.json'

export type { RefineModelPolicy }

// 기본 베이스 경로 — 홈 화면에서 새 워크스페이스 cwd 생성 시 사용.
// `~/AgentBridge`. 사용자는 설정에서 변경 가능. main 프로세스 호출 시점에만 homedir 사용.
function defaultBasePath(): string {
  return path.join(os.homedir(), 'AgentBridge')
}

const DEFAULT_SETTINGS: AppSettings = {
  refineModel: 'priority',
  refinePriorityOrder: ['agy', 'codex', 'claude'],
  refineFixedCli: 'agy',
  theme: 'dark',
  language: 'ko',
  defaultBasePath: '',
  turnsAssistantDetail: 'compact'
}

function getSettingsFilePath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE_NAME)
}

let cache: AppSettings | null = null

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache
  const p = getSettingsFilePath()
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const merged: AppSettings = {
      refineModel: validateRefineModel(parsed.refineModel) ?? DEFAULT_SETTINGS.refineModel,
      refinePriorityOrder:
        validateCliKindArray(parsed.refinePriorityOrder) ?? DEFAULT_SETTINGS.refinePriorityOrder,
      refineFixedCli: validateCliKind(parsed.refineFixedCli) ?? DEFAULT_SETTINGS.refineFixedCli,
      theme: validateTheme(parsed.theme) ?? DEFAULT_SETTINGS.theme,
      language: validateLanguage(parsed.language) ?? DEFAULT_SETTINGS.language,
      defaultBasePath: typeof parsed.defaultBasePath === 'string' ? parsed.defaultBasePath : '',
      turnsAssistantDetail:
        validateTurnsAssistantDetail(parsed.turnsAssistantDetail) ??
        DEFAULT_SETTINGS.turnsAssistantDetail
    }
    cache = merged
    return merged
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn('settings.json 파싱 실패 — 기본값 사용', { err: String(err) })
    }
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings()
  const merged: AppSettings = {
    ...current,
    ...patch,
    refineModel: validateRefineModel(patch.refineModel) ?? current.refineModel,
    refinePriorityOrder:
      validateCliKindArray(patch.refinePriorityOrder) ?? current.refinePriorityOrder,
    refineFixedCli: validateCliKind(patch.refineFixedCli) ?? current.refineFixedCli,
    theme: validateTheme(patch.theme) ?? current.theme,
    language: validateLanguage(patch.language) ?? current.language,
    defaultBasePath:
      typeof patch.defaultBasePath === 'string' ? patch.defaultBasePath : current.defaultBasePath,
    turnsAssistantDetail:
      validateTurnsAssistantDetail(patch.turnsAssistantDetail) ?? current.turnsAssistantDetail
  }
  const p = getSettingsFilePath()
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8')
  await fs.rename(tmp, p)
  cache = merged
  log.info('settings 갱신', merged)
  return merged
}

// defaultBasePath가 빈 문자열이면 `~/AgentBridge`로 해석. 홈 화면 워크스페이스 생성 시 사용.
export function resolveDefaultBasePath(settings: AppSettings): string {
  const trimmed = settings.defaultBasePath?.trim()
  if (trimmed && trimmed.length > 0) return trimmed
  return defaultBasePath()
}

function validateRefineModel(v: unknown): RefineModelPolicy | null {
  if (v === 'priority' || v === 'fixed' || v === 'active' || v === 'off') return v
  // legacy 마이그레이션 — 구버전 정책명들을 priority로 통합 (가장 가까운 의도).
  if (v === 'auto' || v === 'agy-flash' || v === 'gemini-flash') return 'priority'
  return null
}

function validateCliKind(v: unknown): CliKind | null {
  if (v === 'claude' || v === 'codex' || v === 'agy') return v
  return null
}

function validateCliKindArray(v: unknown): CliKind[] | null {
  if (!Array.isArray(v)) return null
  const validated: CliKind[] = []
  for (const item of v) {
    const k = validateCliKind(item)
    if (k && !validated.includes(k)) validated.push(k)
  }
  return validated.length > 0 ? validated : null
}

function validateTheme(v: unknown): ThemeMode | null {
  if (v === 'dark' || v === 'light' || v === 'system') return v
  return null
}

function validateLanguage(v: unknown): LanguageCode | null {
  if (v === 'ko' || v === 'en') return v
  return null
}

function validateTurnsAssistantDetail(v: unknown): TurnsAssistantDetail | null {
  if (v === 'full' || v === 'compact' || v === 'minimal') return v
  return null
}

// EnvProbe에서 agy 어댑터 가용 여부 확인 — RefineDispatcher가 'auto'/'agy-flash' 처리 시 사용.
// 동기 import로 cycle 회피하기 위해 envProbe의 getCliPath만 의존.
export function isAgyAvailable(getCliPath: (kind: CliKind) => string | null): boolean {
  return !!getCliPath('agy')
}
