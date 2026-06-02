// ir.json 읽기/쓰기 — 정제(compaction)와 표시 경로가 공유하는 단일 구현.
// 호스트(extension/desktop)와 core 스케줄러가 같은 검증·atomic write 규칙을 쓰도록 한다.
// (V-14 — ir.json 접근 분산 해소. desktop workspaceStore는 contextId 추가 검증이 있어 별도 유지.)

import { promises as fs } from 'fs';
import { join } from 'path';
import type { IR } from './shared/ir';

export async function readIR(workspaceRoot: string): Promise<IR | null> {
  const irPath = join(workspaceRoot, 'ir.json');
  try {
    const raw = await fs.readFile(irPath, 'utf8');
    const parsed = JSON.parse(raw);
    // 손상된 ir.json이 빈 객체/배열로 파싱되면 meta 누락 → 이후 ir.meta 접근이 throw. 방어적 검증.
    if (!parsed || typeof parsed !== 'object' || !('meta' in parsed)) return null;
    return parsed as IR;
  } catch {
    return null;
  }
}

export async function writeIR(workspaceRoot: string, ir: IR): Promise<void> {
  const irPath = join(workspaceRoot, 'ir.json');
  const tmp = `${irPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ir, null, 2), 'utf8');
  await fs.rename(tmp, irPath);
}
