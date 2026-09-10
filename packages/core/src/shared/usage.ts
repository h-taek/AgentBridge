// CLI 구독 사용량의 공통 형태. 벤더 응답은 normalize에서 이 모양으로 바뀐다.

import type { CliKind } from './cli';

export type UsageStatus =
  | 'ok'              // 조회 성공
  | 'unauthenticated' // 자격증명이 없거나 갱신 후에도 401·403
  | 'unavailable'     // 네트워크 실패, 타임아웃
  | 'unsupported'     // 응답 형식이 기대와 다름
  | 'unknown';        // 아직 한 번도 조회하지 않음

export type UsageWindowId = 'session' | 'weekly';

export interface UsageWindow {
  id: UsageWindowId;
  /** 0~100, 소수 1자리 반올림. 잔량이 아니라 사용량이다. */
  usedPercent: number;
  /** epoch ms. 벤더가 안 주면 null. */
  resetsAt: number | null;
}

export interface UsageSnapshot {
  cli: CliKind;
  planName: string | null;
  windows: UsageWindow[];
  fetchedAt: number;
  status: UsageStatus;
}
