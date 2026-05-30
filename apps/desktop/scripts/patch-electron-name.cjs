#!/usr/bin/env node
// dev 모드 Electron.app 이름을 'AgentBridge'로 패치.
//
// 왜 필요한가:
//   macOS dock 라벨 / 메뉴바 첫 항목 / cmd-tab은 Electron.app/Contents/Info.plist의
//   CFBundleName + CFBundleDisplayName을 기준으로 표시한다. main 코드의 app.setName()은
//   메뉴바·About은 잡지만 dock 라벨은 못 잡는다 — macOS가 plist를 캐시하기 때문.
//   빌드된 앱(`npm run build:mac`)은 electron-builder가 productName으로 따로 plist를 만들어
//   괜찮지만, dev 모드(`npm run dev`)는 node_modules/electron의 원본 Electron.app을 그대로 쓴다.
//
// 적용 단계:
//   1) Info.plist의 CFBundleName + CFBundleDisplayName을 'AgentBridge'로 변경
//   2) dist/Electron.app → dist/AgentBridge.app으로 rename (CFBundleExecutable=Electron은
//      그대로 — 바이너리 이름 변경하면 실행 깨짐). 같은 경로의 .app은 LaunchServices가
//      여전히 stale 캐시를 가질 수 있어 *경로 자체*를 바꾸는 게 가장 확실
//   3) node_modules/electron/path.txt도 새 경로(AgentBridge.app/...)로 갱신
//   4) build/icon.icns → AgentBridge.app/Contents/Resources/electron.icns 복사
//      (dev 모드 dock/메뉴바 아이콘. Info.plist의 CFBundleIconFile=electron.icns가 가리키는 곳)
//   5) lsregister -f로 새 경로 명시 등록
//
// 안전성:
//   - 이미 적용된 경우 noop
//   - electron 미설치/다른 OS면 silent skip
//   - 매 npm install 후 자동 — postinstall에서 호출

const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

if (process.platform !== 'darwin') {
  process.exit(0)
}

const APP_NAME = 'AgentBridge'
const ELECTRON_DIR = path.resolve(__dirname, '..', 'node_modules', 'electron')
const DIST_DIR = path.join(ELECTRON_DIR, 'dist')
const PATH_TXT = path.join(ELECTRON_DIR, 'path.txt')
const SRC_APP = path.join(DIST_DIR, 'Electron.app')
const DST_APP = path.join(DIST_DIR, `${APP_NAME}.app`)
const BUILD_ICNS = path.resolve(__dirname, '..', 'build', 'icon.icns')

// Electron이 npm install 후 .app을 어디에 두었는지 — 둘 중 하나만 존재.
function currentAppPath() {
  if (fs.existsSync(DST_APP)) return DST_APP
  if (fs.existsSync(SRC_APP)) return SRC_APP
  return null
}

const appPath = currentAppPath()
if (!appPath) {
  // electron 미설치 — skip.
  process.exit(0)
}

const plistPath = path.join(appPath, 'Contents', 'Info.plist')

function readKey(key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

function writeKey(key, value) {
  // Set은 존재하는 key만 갱신, 없으면 Add. 우선 Set 시도 → 실패 시 Add.
  const setRes = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath], {
    stdio: 'ignore'
  })
  if (setRes.status === 0) return
  spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plistPath], {
    stdio: 'ignore'
  })
}

// 1) Info.plist 패치 — 이미 같으면 skip.
const currentName = readKey('CFBundleName')
const currentDisplay = readKey('CFBundleDisplayName')
let plistChanged = false
if (currentName !== APP_NAME) {
  writeKey('CFBundleName', APP_NAME)
  plistChanged = true
}
if (currentDisplay !== APP_NAME) {
  writeKey('CFBundleDisplayName', APP_NAME)
  plistChanged = true
}

// 2) Electron.app → AgentBridge.app rename — 새 경로로 캐시 우회.
let renamed = false
if (fs.existsSync(SRC_APP) && !fs.existsSync(DST_APP)) {
  fs.renameSync(SRC_APP, DST_APP)
  renamed = true
} else if (fs.existsSync(SRC_APP) && fs.existsSync(DST_APP)) {
  // 둘 다 있으면(이전 적용 흔적) 원본 제거 — npm install이 새로 풀어 놓은 경우.
  fs.rmSync(SRC_APP, { recursive: true, force: true })
  renamed = true
}

// 3) path.txt 갱신 — electron npm pkg가 spawn 시 읽는 경로 파일.
//    fmt: 'AgentBridge.app/Contents/MacOS/Electron' (바이너리 이름은 그대로 'Electron').
const desiredPath = `${APP_NAME}.app/Contents/MacOS/Electron`
let pathTxtChanged = false
if (fs.existsSync(PATH_TXT)) {
  const cur = fs.readFileSync(PATH_TXT, 'utf8').trim()
  if (cur !== desiredPath) {
    fs.writeFileSync(PATH_TXT, desiredPath, 'utf8')
    pathTxtChanged = true
  }
}

// 4) build/icon.icns → AgentBridge.app/Contents/Resources/electron.icns 복사.
//    dev 모드 메뉴바/dock 아이콘은 .app 안의 .icns에서 옴. build/icon.icns는 production
//    build에만 적용되므로 dev에서 동기화하려면 직접 복사 필요.
const finalAppPath = fs.existsSync(DST_APP) ? DST_APP : SRC_APP
const dstIcns = path.join(finalAppPath, 'Contents', 'Resources', 'electron.icns')
let iconChanged = false
if (fs.existsSync(BUILD_ICNS) && fs.existsSync(dstIcns)) {
  // content 비교로 불필요한 copy 방지(매 npm install마다 mtime 흔들지 않도록).
  const a = fs.readFileSync(BUILD_ICNS)
  const b = fs.readFileSync(dstIcns)
  if (a.length !== b.length || !a.equals(b)) {
    fs.copyFileSync(BUILD_ICNS, dstIcns)
    iconChanged = true
  }
}

if (!plistChanged && !renamed && !pathTxtChanged && !iconChanged) {
  // 모두 이미 적용된 상태 — quiet exit.
  process.exit(0)
}

// 5) LaunchServices 캐시 갱신 — 새 경로의 .app 명시 등록.
//    finalAppPath는 step 4에서 결정됨.
try {
  fs.utimesSync(finalAppPath, new Date(), new Date())
} catch {
  /* noop */
}
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
spawnSync(lsregister, ['-f', finalAppPath], { stdio: 'ignore' })

console.log(
  `[patch-electron-name] applied → ${path.basename(finalAppPath)}${iconChanged ? ' (+ icon)' : ''}`
)
