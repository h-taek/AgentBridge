// 옛 저장소(`~/.agentbridge`)에서 새 저장소(`~/agentbridge`)로 장기 메모리만 옮긴다 (0.5.0 B-1).
//
// 워크스페이스 데이터는 안 옮긴다. 잃어도 복구 가능하기 때문이다 — ir.json은 대화하면 다시 만들어지고,
// turns.jsonl은 CLI transcript의 파생물이며, 세션 매핑은 우리 목록에서만 사라진다(CLI 자체 resume은 그대로).
// 장기 메모리(`global/`)만 우리가 가진 원본이라 이것만 복사한다.
//
// 옛 폴더는 지우지 않는다. 비용이 들지 않으면서 되돌릴 수 있고, 사용자 입장에서도
// "날렸다"가 아니라 "안 쓴다"가 된다.

import { cpSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getLegacyStorageRoot, getStorageRoot } from './storageRoot';
import { type Logger, noopLogger } from './interfaces';

export type LegacyMigrationResult = 'copied' | 'skipped-already-present' | 'skipped-no-legacy';

export type MigrateLegacyGlobalOptions = {
  root?: string;
  legacyRoot?: string;
  logger?: Logger;
};

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function migrateLegacyGlobalIfNeeded(
  opts: MigrateLegacyGlobalOptions = {},
): LegacyMigrationResult {
  const log = opts.logger ?? noopLogger;
  const target = join(opts.root ?? getStorageRoot(), 'global');
  const source = join(opts.legacyRoot ?? getLegacyStorageRoot(), 'global');

  if (hasEntries(target)) return 'skipped-already-present';
  if (!existsSync(source) || !hasEntries(source)) return 'skipped-no-legacy';

  cpSync(source, target, { recursive: true });
  log.log(`legacyMigration: copied global memory ${source} -> ${target}`);
  return 'copied';
}
