// refine 서브프로세스(agy/codex CLI)를 격리된 HOME 박스에서 실행하기 위한 환경 변수 조립.
// darwin 전용 — 다른 플랫폼은 현행 동작(실제 HOME) 유지.

import { homedir } from 'os';
import { join } from 'path';
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

// 임시 스텁 — Task 2-4에서 실제 부트스트랩 구현 예정.
function bootstrapIfNeeded(_cli: CliKind, _box: string, _realHome: string, _binPath?: string): void {}
