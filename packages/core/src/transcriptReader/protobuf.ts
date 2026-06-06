// 최소 protobuf wire 디코더 — agy step_payload(평문 protobuf) 전용. 스키마/의존성 없음.
// 필요한 것만: 필드 번호별 값 추출 + 중첩 메시지 재귀.

export interface PbField {
  field: number;
  kind: 'varint' | 'bytes' | 'i64' | 'i32';
  value: number | Buffer;
}

function readVarint(b: Buffer, i: number): { value: number; next: number } {
  let shift = 0;
  let res = 0;
  while (i < b.length) {
    const x = b[i++];
    res += (x & 0x7f) * Math.pow(2, shift); // >>32 안전하게 곱셈 누적
    if ((x & 0x80) === 0) return { value: res, next: i };
    shift += 7;
  }
  return { value: res, next: i };
}

// 한 메시지의 top-level 필드들을 디코드. 깨진 바이트는 거기서 중단(부분 결과 반환).
export function decodeProtobuf(b: Buffer): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < b.length) {
    const t = readVarint(b, i);
    const tag = t.value;
    i = t.next;
    const field = tag >>> 3;
    const wt = tag & 0x7;
    if (field === 0) break;
    if (wt === 0) {
      const v = readVarint(b, i);
      out.push({ field, kind: 'varint', value: v.value });
      i = v.next;
    } else if (wt === 2) {
      const len = readVarint(b, i);
      i = len.next;
      if (i + len.value > b.length) break;
      out.push({ field, kind: 'bytes', value: b.subarray(i, i + len.value) });
      i += len.value;
    } else if (wt === 5) {
      out.push({ field, kind: 'i32', value: b.readUInt32LE(i) });
      i += 4;
    } else if (wt === 1) {
      out.push({ field, kind: 'i64', value: 0 });
      i += 8;
    } else {
      break; // 알 수 없는 wire type — 중단
    }
  }
  return out;
}

function looksLikeText(buf: Buffer): string | null {
  let s: string;
  try {
    s = buf.toString('utf8');
  } catch {
    return null;
  }
  // round-trip로 유효 utf8 확인 + 인쇄가능 비율
  if (Buffer.from(s, 'utf8').length !== buf.length) return null;
  if (s.length === 0) return null;
  let printable = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13 || c >= 32) printable++;
  }
  return printable / s.length > 0.85 ? s : null;
}

export interface PbString {
  field: number;
  text: string;
  depth: number;
}

// 재귀로 모든 텍스트 string 필드를 모은다 (bytes 필드가 utf8이면 string, 아니면 중첩 메시지로 재귀).
export function collectStrings(b: Buffer, maxDepth: number, depth = 0): PbString[] {
  const out: PbString[] = [];
  for (const f of decodeProtobuf(b)) {
    if (f.kind !== 'bytes') continue;
    const buf = f.value as Buffer;
    const text = looksLikeText(buf);
    if (text) {
      out.push({ field: f.field, text, depth });
    } else if (depth < maxDepth) {
      out.push(...collectStrings(buf, maxDepth, depth + 1));
    }
  }
  return out;
}

// 한 메시지에서 특정 top-level 필드 번호의 첫 string 값.
export function topLevelString(b: Buffer, field: number): string | null {
  for (const f of decodeProtobuf(b)) {
    if (f.field === field && f.kind === 'bytes') {
      const text = looksLikeText(f.value as Buffer);
      if (text) return text;
    }
  }
  return null;
}
