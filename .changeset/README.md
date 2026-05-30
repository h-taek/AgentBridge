# Changesets

각 변경마다 `pnpm changeset`을 실행해 어떤 패키지가 어떤 단계(major/minor/patch)로
bump되는지 기록합니다. `pnpm version-packages`가 이 기록을 모아 버전을 올립니다.

## 운영 정책

- **CHANGELOG는 각 패키지의 `CHANGELOG.md`에 직접 작성합니다.**
  changesets의 자동 CHANGELOG 생성은 비활성화되어 있습니다
  (`config.json`의 `"changelog": false`).
- `changeset version`은 `package.json`의 `version` bump 용도로만 사용합니다.
- 데스크탑/익스텐션을 **개별로 bugfix 배포**할 때 패키지별 독립 bump의 안전망으로
  활용하는 것이 주 목적입니다.

See https://github.com/changesets/changesets for full docs.
