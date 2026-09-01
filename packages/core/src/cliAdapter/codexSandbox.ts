// codex 샌드박스 쓰기 허용 (0.5.0 3단계 W5, B-5).
//
// codex 기본 샌드박스는 워크스페이스 밖 읽기와 프로그램 실행은 통과시키지만 밖 쓰기는 막는다.
// 우리 CLI는 모델 셸의 자식이라 같은 샌드박스를 물려받으므로, 우리 저장소에 쓰는 명령이
// 그대로 막힌다. 저장소 폴더 하나를 쓰기 허용으로 더하면 통과한다(실측).
//
// 여는 것은 우리 저장소 한 폴더뿐이고 샌드박스 모드는 건드리지 않는다. 사용자가 read-only로
// 두었으면 그 결정이 유지된다.
//
// 걸리는 곳이 하나 있다. `-c`는 배열을 합치지 않고 통째로 덮는다. 사용자가 이미 쓰기 허용
// 폴더를 설정해 뒀으면 우리 인자가 그것을 조용히 지운다. 그래서 기존 값을 먼저 읽어 합친다.
// TOML 파서를 들이지 않는다(의존성 0) — 우리가 보는 것은 문자열 배열 하나뿐이고, 못 읽으면
// 우리 것만 넘긴다.

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const ARRAY_RE = /writable_roots\s*=\s*\[([\s\S]*?)\]/;
const STRING_RE = /"([^"]*)"|'([^']*)'/g;

// 기본 설정의 writable_roots만 본다. `[profiles.*]` 아래 것은 그 프로필을 켤 때만 도는 값이라
// 합치면 사용자가 의도한 것보다 넓게 연다.
export function parseWritableRoots(toml: string): string[] {
  const lines = toml.split('\n');
  let section = '';
  const chunks: string[] = [];
  let collecting = false;
  let depth = 0;

  for (const line of lines) {
    const header = SECTION_RE.exec(line);
    if (header && !collecting) {
      section = header[1]!.trim();
      continue;
    }
    const relevant =
      section === 'sandbox_workspace_write' ||
      /(^|\.)sandbox_workspace_write\.writable_roots\s*=/.test(line);
    if (!collecting && !relevant) continue;
    if (!collecting && !line.includes('writable_roots')) continue;

    if (!collecting) {
      collecting = true;
      chunks.length = 0;
    }
    chunks.push(line);
    depth += (line.match(/\[/g)?.length ?? 0) - (line.match(/\]/g)?.length ?? 0);
    if (depth <= 0 && chunks.join('\n').includes(']')) break;
  }

  const body = ARRAY_RE.exec(chunks.join('\n'))?.[1];
  if (body === undefined) return [];
  const out: string[] = [];
  for (const m of body.matchAll(STRING_RE)) out.push(m[1] ?? m[2] ?? '');
  return out.filter(Boolean);
}

// `-c sandbox_workspace_write.writable_roots=[...]` 한 쌍. 값은 TOML로 파싱되므로 JSON 배열
// 표기를 그대로 쓴다.
export function buildWritableRootsArgs(storageRoot: string, existing: string[]): string[] {
  const roots = existing.includes(storageRoot) ? existing : [...existing, storageRoot];
  return ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`];
}
