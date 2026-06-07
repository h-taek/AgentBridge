// agy conversation .db에서 step 행을 읽는다. node:sqlite(무의존, Node 22.5+/Electron 동봉).
// BLOB은 Uint8Array로 오므로 Buffer로 래핑해 protobuf 디코더에 넘긴다.
// 런타임에 node:sqlite가 없으면(구 Electron/IDE host) 이 함수만 sql.js 등으로 교체하면 됨.
// node:sqlite 타입은 ambient 선언(node-sqlite.d.ts) — 현재 @types/node에 없어 사용 표면만 최소 정의.
import { DatabaseSync } from 'node:sqlite';
import type { AgyStepRow } from './agyReader';

export function readAgySteps(dbPath: string, afterIdx: number): AgyStepRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT idx, step_type AS stepType, step_payload AS payload FROM steps WHERE idx > ? ORDER BY idx',
      )
      .all(afterIdx) as Array<{ idx: number; stepType: number; payload: Uint8Array }>;
    return rows.map((r) => ({
      idx: Number(r.idx),
      stepType: Number(r.stepType),
      payload: Buffer.from(r.payload),
    }));
  } finally {
    db.close();
  }
}
