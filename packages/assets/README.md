# @agentbridge/assets

브랜드 에셋 **단일 원본**. agent 로고·AgentBridge 마크·모델 색을 여기 한 곳에서만 관리한다.

- `logos/{claude,codex,agy}.svg` — agent 공식 로고 (멀티컬러 브랜드 아트).
- `brand/agentbridge.svg` — AgentBridge 마크 (currentColor 단색).
- `brand/agentbridge-{light,dark}.svg` — 컬러 마크 (밝은/어두운 배경용).
- `brand/icon-light.png` — 미사용 래스터(파킹). 연결된 소비처 없음.
- `colors.json` — 모델 색 단일 정의 `{ claude, codex, agy }`.

## 소비 방식

- **extension (vsce)**: 런타임에 자기 폴더의 파일 경로를 찾으므로 `esbuild.mjs`가 빌드 때 `media/`로 복사·생성한다(xterm vendoring과 동일). `media/logos`·`media/icon*.svg`·`media/dots`는 생성물이라 gitignore.

## 빼는 것 (포맷이 강제되는 래스터)

마켓 아이콘(`apps/extension/media/icon.png`)은 도구가 래스터를 고정 경로에서 요구해 SVG로 대체 불가 → 그 자리에 유지(마스터에서 파생).
