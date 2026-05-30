#!/usr/bin/env bash
# build-mac-external.sh — iCloud Drive 디렉토리 우회 빌드.
#
# 왜 필요한가:
#   본 프로젝트 작업 디렉토리가 ~/Library/Mobile Documents/com~apple~CloudDocs/... (iCloud Drive)
#   안에 있을 경우, macOS Sequoia가 모든 파일에 com.apple.provenance 시스템 attribute를
#   자동 부여한다. 이 attribute는 codesign이 "resource fork ... not allowed" 에러로 거부 →
#   ad-hoc 서명·정식 인증서 서명·노타리 흐름 모두 실패.
#   xattr -dr로도 제거 불가 (시스템 보호 attribute).
#
# 우회 방식:
#   ~/.agentbridge-build/ (iCloud 영역 밖) 으로 source를 sync한 뒤 그곳에서 빌드.
#   provenance가 부여되지 않으므로 codesign 정상 통과. 빌드 산출물(dist/*.dmg/*.zip/...)만
#   원래 위치로 회수.
#
# 흐름:
#   1) source sync — tar로 xattr 자동 제외하며 BUILD_DIR로 복사 (node_modules/dist/out/.git 제외)
#   2) node_modules — package-lock 변경 감지해 clean install (첫 빌드 + 의존성 변경 시만)
#   3) build:mac in BUILD_DIR — electron-vite build + electron-builder --mac
#   4) artifacts 회수 — BUILD_DIR/dist → PROJECT_DIR/dist
#
# 사용: `npm run build:mac:external`

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${AGENTBRIDGE_BUILD_DIR:-$HOME/.agentbridge-build}"
LOCK_CACHE="$BUILD_DIR/.last-package-lock"

echo "[external-build] project    = $PROJECT_DIR"
echo "[external-build] build dir  = $BUILD_DIR"

# 1) source sync — tar로 xattr 제외하며 복사.
echo "[external-build] sync source → $BUILD_DIR"
mkdir -p "$BUILD_DIR"
tar -cf - \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=out \
  --exclude=.git \
  --exclude=.DS_Store \
  -C "$PROJECT_DIR" . \
  | tar -xf - -C "$BUILD_DIR"

# 2) node_modules — clean install이 필요한 경우만.
NEEDS_INSTALL=0
if [ ! -d "$BUILD_DIR/node_modules" ]; then
  NEEDS_INSTALL=1
  echo "[external-build] node_modules 없음 — clean install 진행"
elif [ ! -f "$LOCK_CACHE" ] || ! cmp -s "$PROJECT_DIR/package-lock.json" "$LOCK_CACHE"; then
  NEEDS_INSTALL=1
  echo "[external-build] package-lock 변경 감지 — clean install 진행"
fi

if [ "$NEEDS_INSTALL" -eq 1 ]; then
  rm -rf "$BUILD_DIR/node_modules"
  (cd "$BUILD_DIR" && npm install)
  cp "$PROJECT_DIR/package-lock.json" "$LOCK_CACHE"
fi

# 3) build:mac — external dir에서 직접 호출.
echo "[external-build] running build:mac in $BUILD_DIR"
(
  cd "$BUILD_DIR"
  unset ELECTRON_RUN_AS_NODE
  npx electron-vite build
  npx electron-builder --mac
)

# 4) artifacts 회수.
echo "[external-build] sync artifacts → $PROJECT_DIR/dist"
rm -rf "$PROJECT_DIR/dist"
mkdir -p "$PROJECT_DIR/dist"
cp -R "$BUILD_DIR/dist/." "$PROJECT_DIR/dist/"

echo "[external-build] done"
ls -lh "$PROJECT_DIR/dist/" | head -20
