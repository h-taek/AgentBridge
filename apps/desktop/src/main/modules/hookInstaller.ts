// 데스크탑 hookInstaller — Phase C 이후 lean facade.
//
// 책임:
//   1) agentbridge-memory 헬퍼 binary 절대경로 해석 (dev/prod 분기)
//   2) globalStoragePath 해석 (core getStorageRoot — ~/.agentbridge, V-12)
//   3) 코어 createHookInstaller 인스턴스 lazy singleton
//   4) legacy `.gemini/settings.json` _agentbridge_managed entry 정리 (옛 desktop 잔재)
//
// CLI별 install 로직(claude/codex/agy 파일 작성, 마커 merge, atomic write)은 모두 코어 위임.

import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { promises as fs } from 'fs'
import * as path from 'path'
import log from 'electron-log/main'
import { createHookInstaller, getStorageRoot, type HookInstaller } from '@agentbridge/core'

// dev/prod 모두에서 resources/bin/agentbridge-memory.js 절대경로를 반환.
// dev: <repo>/resources/bin/... (app.getAppPath()가 repo root)
// prod: <.app>/Contents/Resources/app.asar.unpacked/resources/bin/... — electron-builder가
//       asarUnpack 패턴(`resources/**`)에 매칭된 파일을 app.asar 옆 `app.asar.unpacked/<원경로>`에
//       풀어두므로, 호스트 셸 hook(외부 프로세스 spawn)이 실제 디스크 파일로 접근하려면 이 경로 사용.
export function getHelperBinaryPath(): string {
  if (is.dev) {
    return path.join(app.getAppPath(), 'resources', 'bin', 'agentbridge-memory.js')
  }
  return path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'resources',
    'bin',
    'agentbridge-memory.js'
  )
}

async function assertHelperExists(helperPath: string): Promise<void> {
  try {
    await fs.access(helperPath)
  } catch {
    throw new Error(
      `agentbridge-memory helper binary not found at ${helperPath} — dev: resources/bin/agentbridge-memory.js 존재 확인`
    )
  }
}

let _coreHookInstaller: HookInstaller | null = null

export function getDesktopHookInstaller(): HookInstaller {
  if (!_coreHookInstaller) {
    const helperPath = getHelperBinaryPath()
    _coreHookInstaller = createHookInstaller({
      helperPath,
      globalStoragePath: getStorageRoot(),
      logger: {
        log: (m) => log.info(m),
        warn: (m) => log.warn(m)
      }
    })
    // helper 누락 가드 — 처음 호출 시점에 sync 검증. install 단계에서 silent fail 방지.
    void assertHelperExists(helperPath).catch((err) => {
      log.error('hookInstaller: helper binary 검증 실패', { helperPath, err: String(err) })
    })
  }
  return _coreHookInstaller
}

// ─── legacy `.gemini/settings.json` cleanup ─────────────────────────────
//
// 구버전(M3 N 이전) `installGeminiHooks`가 만든 cwd/.gemini/settings.json 안 우리 entry
// (_agentbridge_managed: true) 제거. 사용자 콘텐츠는 보존. agy hook 설치 시 한 번 호출.

type HookEntry = {
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
  _agentbridge_managed?: true
}
type HooksRoot = {
  hooks?: Record<string, HookEntry[]>
} & Record<string, unknown>

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, filePath)
}

export async function cleanupLegacyGeminiSettings(cwd: string): Promise<boolean> {
  const legacyPath = path.join(cwd, '.gemini', 'settings.json')
  const raw = await readFileIfExists(legacyPath)
  if (!raw) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!isObject(parsed)) return false
  const root = parsed as HooksRoot
  if (!isObject(root.hooks)) return false
  const hooksMap = root.hooks as Record<string, HookEntry[]>
  let touched = false
  for (const [name, entries] of Object.entries(hooksMap)) {
    if (!Array.isArray(entries)) continue
    const filtered = entries.filter((e) => !(isObject(e) && e._agentbridge_managed === true))
    if (filtered.length !== entries.length) {
      touched = true
      if (filtered.length === 0) {
        delete hooksMap[name]
      } else {
        hooksMap[name] = filtered
      }
    }
  }
  if (!touched) return false
  if (Object.keys(hooksMap).length === 0) {
    delete root.hooks
  } else {
    root.hooks = hooksMap
  }
  if (Object.keys(root).length === 0) {
    try {
      await fs.unlink(legacyPath)
      log.info('legacy .gemini/settings.json 제거', { legacyPath })
    } catch {
      /* noop */
    }
    return true
  }
  await atomicWriteFile(legacyPath, JSON.stringify(root, null, 2))
  log.info('legacy .gemini/settings.json _agentbridge_managed entry 정리', { legacyPath })
  return true
}
