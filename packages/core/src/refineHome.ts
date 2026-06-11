// refine 서브프로세스(agy/codex CLI)를 격리된 HOME 박스에서 실행하기 위한 환경 변수 조립.
// 앱이 macOS 전용이므로 플랫폼 분기 없음 (claude는 격리 미지원으로 빈 env).

import { mkdirSync, symlinkSync, lstatSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { CliKind } from './shared/cli';

export type EnsureRefineHomeOptions = {
  rootDir?: string;            // 박스 루트; 기본값 ~/.agentbridge/cli-homes
  realHome?: string;           // 심볼릭 링크 소스 HOME; 기본값 homedir()
  binPath?: string;            // CLI 바이너리 경로 (버전 토큰용); 없으면 버전 확인 생략
};

export type RefineHomeResult = { env: Record<string, string> };

export function ensureRefineHome(cli: CliKind, opts: EnsureRefineHomeOptions = {}): RefineHomeResult {
  if (cli === 'claude') return { env: {} };        // claude는 격리 미지원 (deferred)
  const rootDir = opts.rootDir ?? join(homedir(), '.agentbridge', 'cli-homes');
  const realHome = opts.realHome ?? homedir();
  const box = join(rootDir, cli);
  bootstrapIfNeeded(cli, box, realHome, opts.binPath);  // 격리 박스 부팅: 버전 토큰 확인 후 재사용 또는 rm -rf 재생성 + 심링크/최소config
  if (cli === 'agy') return { env: { HOME: box } };
  if (cli === 'codex') return { env: { CODEX_HOME: box } };
  const _exhaustive: never = cli;   // compile-time guard for new CliKind members
  return _exhaustive;
}

function versionToken(binPath?: string): string {
  if (!binPath) return 'no-bin';
  try { const s = statSync(binPath); return `${s.size}:${Math.floor(s.mtimeMs)}`; }
  catch { return 'no-bin'; }
}

// linkPath가 이미 존재(dangling 심링크 포함)하면 스킵 — 재실행 시 EEXIST 방지.
function linkOnce(target: string, linkPath: string): void {
  try { lstatSync(linkPath); return; }                       // already exists (incl. dangling) → reuse
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }  // ENOENT → create below
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
}

// target이 실제 존재할 때만 심링크 생성 — dangling 링크로 codex를 혼란시키지 않음.
function linkIfTargetExists(target: string, linkPath: string): void {
  try { lstatSync(target); } catch { return; }  // real target absent → skip (codex will clone locally)
  linkOnce(target, linkPath);
}

// plugins 항목을 일부러 넣지 않는다 — config에 [plugins."..."]가 있으면 codex가
// 첫 부팅 때 ~69MB 플러그인 마켓플레이스를 .tmp에 git clone한다. refine는 플러그인이
// 불필요하므로 최소 config로 박스를 ~6MB로 유지. (real ~/.codex/config.toml 복사 금지)
const CODEX_MIN_CONFIG = '[features]\nsuppress_unstable_features_warning = true\n';

// agy 온보딩(색 테마·ToS 위저드) 완료 마커. quota probe가 인터랙티브 TUI를 띄울 때 빈 박스라
// first-run 위저드에 갇혀 /usage가 묻히는 것을 방지한다. 게이트는 cache/onboarding.json 하나뿐임을
// 격리 bisect로 확인 → 실 홈 의존 없이 직접 써넣는다 (codex config와 같은 시드 패턴). refine는 비-TUI라 무관.
const AGY_ONBOARDING_DONE =
  '{"consumerOnboardingComplete":true,"enterpriseOnboardingComplete":false,"onboardingComplete":true}';

function bootstrapIfNeeded(cli: CliKind, box: string, realHome: string, binPath?: string): void {
  const token = versionToken(binPath);
  const verFile = join(box, '.ab-version');
  let stale = true;
  try { stale = readFileSync(verFile, 'utf8') !== token; } catch { stale = true; }  // missing → stale
  if (stale) rmSync(box, { recursive: true, force: true });
  mkdirSync(box, { recursive: true });
  if (cli === 'agy') {
    linkOnce(join(realHome, 'Library/Keychains'), join(box, 'Library/Keychains'));
    linkOnce(join(realHome, 'Library/Caches'), join(box, 'Library/Caches'));
    linkOnce(join(realHome, '.gemini/antigravity-cli/bin'), join(box, '.gemini/antigravity-cli/bin'));
    // 온보딩 완료 마커를 써넣어 first-run 위저드를 건너뛴다 → probe가 곧장 /usage로.
    const onb = join(box, '.gemini/antigravity-cli/cache/onboarding.json');
    if (!existsSync(onb)) {
      mkdirSync(dirname(onb), { recursive: true });
      writeFileSync(onb, AGY_ONBOARDING_DONE);
    }
  }
  if (cli === 'codex') {
    linkOnce(join(realHome, '.codex/auth.json'), join(box, 'auth.json'));
    const cfg = join(box, 'config.toml');
    if (!existsSync(cfg)) writeFileSync(cfg, CODEX_MIN_CONFIG);
    linkIfTargetExists(join(realHome, '.codex/.tmp/plugins'), join(box, '.tmp/plugins'));
    linkIfTargetExists(join(realHome, '.codex/.tmp/plugins.sha'), join(box, '.tmp/plugins.sha'));
  }
  if (stale) writeFileSync(verFile, token);
}
