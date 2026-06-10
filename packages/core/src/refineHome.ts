// refine 서브프로세스(agy/codex CLI)를 격리된 HOME 박스에서 실행하기 위한 환경 변수 조립.
// darwin 전용 — 다른 플랫폼은 현행 동작(실제 HOME) 유지.

import { mkdirSync, symlinkSync, lstatSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { CliKind } from './shared/cli';

export type EnsureRefineHomeOptions = {
  platform?: NodeJS.Platform;  // 테스트 주입용; 기본값 process.platform
  rootDir?: string;            // 박스 루트; 기본값 ~/.agentbridge/cli-homes
  realHome?: string;           // 심볼릭 링크 소스 HOME; 기본값 homedir()
  binPath?: string;            // CLI 바이너리 경로 (버전 토큰용); 없으면 버전 확인 생략
};

export type RefineHomeResult = { env: Record<string, string> };

export function ensureRefineHome(cli: CliKind, opts: EnsureRefineHomeOptions = {}): RefineHomeResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return { env: {} };  // non-darwin = 현행 동작 (실제 HOME 유지)
  if (cli === 'claude') return { env: {} };        // claude는 격리 미지원 (deferred)
  const rootDir = opts.rootDir ?? join(homedir(), '.agentbridge', 'cli-homes');
  const realHome = opts.realHome ?? homedir();
  const box = join(rootDir, cli);
  bootstrapIfNeeded(cli, box, realHome, opts.binPath);  // 실제 구현은 이후 Task 2-4에서
  if (cli === 'agy') return { env: { HOME: box } };
  if (cli === 'codex') return { env: { CODEX_HOME: box } };
  const _exhaustive: never = cli;   // compile-time guard for new CliKind members
  return _exhaustive;
}

// linkPath가 이미 존재(dangling 심링크 포함)하면 스킵 — 재실행 시 EEXIST 방지.
function linkOnce(target: string, linkPath: string): void {
  try { lstatSync(linkPath); return; }                       // already exists (incl. dangling) → reuse
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }  // ENOENT → create below
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
}

// plugins 항목을 일부러 넣지 않는다 — config에 [plugins."..."]가 있으면 codex가
// 첫 부팅 때 ~69MB 플러그인 마켓플레이스를 .tmp에 git clone한다. refine는 플러그인이
// 불필요하므로 최소 config로 박스를 ~6MB로 유지. (real ~/.codex/config.toml 복사 금지)
const CODEX_MIN_CONFIG = '[features]\nsuppress_unstable_features_warning = true\n';

function bootstrapIfNeeded(cli: CliKind, box: string, realHome: string, _binPath?: string): void {
  mkdirSync(box, { recursive: true });
  if (cli === 'agy') {
    linkOnce(join(realHome, 'Library/Keychains'), join(box, 'Library/Keychains'));
    linkOnce(join(realHome, 'Library/Caches'), join(box, 'Library/Caches'));
    linkOnce(join(realHome, '.gemini/antigravity-cli/bin'), join(box, '.gemini/antigravity-cli/bin'));
  }
  if (cli === 'codex') {
    linkOnce(join(realHome, '.codex/auth.json'), join(box, 'auth.json'));
    const cfg = join(box, 'config.toml');
    if (!existsSync(cfg)) writeFileSync(cfg, CODEX_MIN_CONFIG);
  }
}
