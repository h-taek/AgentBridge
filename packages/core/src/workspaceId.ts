// 결정적 워크스페이스 ID — 폴더 경로의 UUID v5 (V-12).
//
// 같은 폴더면 어느 앱(데스크탑/익스텐션)이 언제 계산해도 같은 ID가 나온다.
// 덕분에 "폴더 → ID" 매핑 장부(workspaces.json)가 필요 없고, 장부 동시 갱신 충돌도 원천 제거.
//
// 형식은 표준 UUID — 기존 코드의 UUID 검증(경로 탈출 방어)을 그대로 통과한다.

import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { resolve } from 'path';

// AgentBridge 고정 네임스페이스 UUID. 변경 금지 — 바꾸면 모든 워크스페이스 ID가 달라져
// 기존 저장 데이터와 연결이 끊긴다.
const AGENTBRIDGE_NAMESPACE = 'c5a1e2d4-7b3f-4e89-9a26-d18f3c2b4a01';

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function deterministicWorkspaceId(folderFsPath: string): string {
  // 심볼릭 링크 해소 + 절대경로 정규화. 폴더가 아직 없으면 resolve만 (생성 전 호출 대비).
  let canonical: string;
  try {
    canonical = realpathSync(folderFsPath);
  } catch {
    canonical = resolve(folderFsPath);
  }

  // RFC 4122 §4.3 UUID v5: SHA-1(namespace bytes + name bytes) → version/variant 비트 세팅
  const hash = createHash('sha1')
    .update(uuidToBytes(AGENTBRIDGE_NAMESPACE))
    .update(canonical, 'utf8')
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
