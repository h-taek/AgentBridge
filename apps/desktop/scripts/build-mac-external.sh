#!/usr/bin/env bash
# build-mac-external.sh — iCloud Drive 디렉토리 우회 빌드 (pnpm 모노레포).
#
# 왜 필요한가:
#   본 프로젝트 작업 디렉토리가 ~/Library/Mobile Documents/com~apple~CloudDocs/... (iCloud Drive)
#   안에 있을 경우, macOS Sequoia가 모든 파일에 com.apple.provenance 시스템 attribute를
#   자동 부여한다. 이 attribute는 codesign이 "resource fork ... not allowed" 에러로 거부 →
#   ad-hoc 서명·정식 인증서 서명·노타리 흐름 모두 실패.
#   xattr -dr로도 제거 불가 (시스템 보호 attribute).
#
# 우회 방식:
#   ~/.agentbridge-build/ (iCloud 영역 밖) 으로 *모노레포 전체*를 sync한 뒤 그곳에서 빌드.
#   provenance가 부여되지 않으므로 codesign 정상 통과. 산출물(apps/desktop/dist/*)만 회수.
#
# 흐름:
#   1) source sync — tar로 xattr 자동 제외하며 BUILD_DIR로 *레포 루트 전체* 복사
#      (node_modules/dist/out/.git 제외 — 어느 깊이든)
#   2) pnpm install — pnpm-lock 변경 감지 시만 (workspace 전체, 네이티브 rebuild 포함)
#   3) build — core 먼저(desktop main이 번들로 인라인) → desktop build:mac
#   4) artifacts 회수 — BUILD_DIR/apps/desktop/dist → <repo>/apps/desktop/dist
#
# 사용: `npm run build:mac:external` (apps/desktop에서)

set -euo pipefail

# 스크립트 위치: <repo>/apps/desktop/scripts/ → 루트는 세 단계 위.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
BUILD_DIR="${AGENTBRIDGE_BUILD_DIR:-$HOME/.agentbridge-build}"
LOCK_CACHE="$BUILD_DIR/.last-pnpm-lock"

echo "[external-build] repo root  = $REPO_ROOT"
echo "[external-build] build dir  = $BUILD_DIR"

# 1) source sync — 모노레포 전체를 rsync --delete로 복사.
#    rsync -a는 기본적으로 xattr(com.apple.provenance)를 옮기지 않으므로(-X 미지정) tar와 동일한
#    codesign 우회 효과를 유지하면서, --delete로 *소스에서 삭제된 파일*도 BUILD_DIR에서 제거한다
#    (tar 덮어쓰기는 stale 파일을 남겨 삭제된 모듈이 빌드 에러를 일으켰음). 제외 항목은 --delete
#    대상에서 보호되어 node_modules는 보존된다.
echo "[external-build] sync source → $BUILD_DIR"
mkdir -p "$BUILD_DIR"
rsync -a --delete \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=out \
  --exclude=.git \
  --exclude=.DS_Store \
  "$REPO_ROOT"/ "$BUILD_DIR"/

# 2) pnpm install — pnpm-lock 변경 감지 시만. desktop postinstall이 네이티브 모듈을
#    electron ABI로 rebuild한다(electron-builder install-app-deps).
NEEDS_INSTALL=0
if [ ! -d "$BUILD_DIR/node_modules" ]; then
  NEEDS_INSTALL=1
  echo "[external-build] node_modules 없음 — install 진행"
elif [ ! -f "$LOCK_CACHE" ] || ! cmp -s "$REPO_ROOT/pnpm-lock.yaml" "$LOCK_CACHE"; then
  NEEDS_INSTALL=1
  echo "[external-build] pnpm-lock 변경 감지 — install 진행"
fi

if [ "$NEEDS_INSTALL" -eq 1 ]; then
  (cd "$BUILD_DIR" && pnpm install)
  cp "$REPO_ROOT/pnpm-lock.yaml" "$LOCK_CACHE"
fi

# 3) build — core(desktop main에 번들) 먼저, 그다음 desktop build:mac.
echo "[external-build] build core + desktop in $BUILD_DIR"
(
  cd "$BUILD_DIR"
  pnpm --filter @agentbridge/core build
  cd apps/desktop
  unset ELECTRON_RUN_AS_NODE
  pnpm run build:mac
)

# 4) artifacts 회수 → apps/desktop/dist.
echo "[external-build] sync artifacts → $DESKTOP_DIR/dist"
rm -rf "$DESKTOP_DIR/dist"
mkdir -p "$DESKTOP_DIR/dist"
cp -R "$BUILD_DIR/apps/desktop/dist/." "$DESKTOP_DIR/dist/"

echo "[external-build] done"
ls -lh "$DESKTOP_DIR/dist/" | head -20
