// replay.log tail 프리미티브 (Plan 2b) — 주어진 오프셋부터 파일 끝까지의 새 바이트만 읽는다.
// 미러링이 소유 앱의 새 출력만 중복·누락 없이 따라 그릴 수 있게 하는 핵심.
//
// 파일이 잘린 경우(현재 크기 < 오프셋: 소유 앱이 replay.log를 재초기화) 처음부터 다시 읽는다.

import { promises as fsp } from 'fs';

export async function readAppendedBytes(
  filePath: string,
  fromOffset: number,
): Promise<{ data: string; newOffset: number }> {
  let size: number;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch {
    return { data: '', newOffset: 0 }; // 파일 없음
  }

  // 잘림 감지 — 현재 크기가 오프셋보다 작으면 재초기화된 것. 처음부터.
  const start = size < fromOffset ? 0 : fromOffset;
  if (size <= start) return { data: '', newOffset: size };

  const fh = await fsp.open(filePath, 'r');
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return { data: buf.toString('utf8'), newOffset: size };
  } finally {
    await fh.close();
  }
}
