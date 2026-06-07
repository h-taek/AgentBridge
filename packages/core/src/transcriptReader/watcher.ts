// transcript watcher 프리미티브. IO만 담당 — 파싱은 reader, 스케줄링은 manager.
//
// readJsonlIncrement: append-only jsonl을 offset부터 증분 읽어 완전한 라인만 JSON으로 파싱한다.
//   - 마지막 미완성 라인(개행 없음)은 보류: offset을 마지막 개행 다음까지만 전진(다음 호출에 합쳐 재처리).
//   - 깨진 라인(JSON.parse 실패)은 그것만 skip(전체 중단 없음 — design §F 격리 원칙).
import { readAppendedBytes } from '../fileTail';

export interface JsonlIncrement {
  records: unknown[];
  offset: number;
}

export async function readJsonlIncrement(filePath: string, fromOffset: number): Promise<JsonlIncrement> {
  const { data } = await readAppendedBytes(filePath, fromOffset);
  if (!data) return { records: [], offset: fromOffset };

  const lastNl = data.lastIndexOf('\n');
  if (lastNl < 0) {
    // 완전한 라인 없음 — 보류(offset 미전진).
    return { records: [], offset: fromOffset };
  }

  const completeStr = data.slice(0, lastNl + 1); // 마지막 개행 포함까지만 소비
  const consumedBytes = Buffer.byteLength(completeStr, 'utf8');
  const records: unknown[] = [];
  for (const line of completeStr.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      // 깨진 라인 skip (design §F — 하나가 깨져도 전체는 계속)
    }
  }
  return { records, offset: fromOffset + consumedBytes };
}
