// TurnRecord — handoff context의 raw 단위.
//
// turns.jsonl append-only NDJSON, 1 record = 1 turn.
// Compaction scheduler가 oldest 청크를 처리해 IR로 흡수하고 turns.jsonl을 rewrite.
// 최근 N개(`keepRecent`)는 항상 raw 보존 — hook 본문에 inject.

import type { CliKind } from './cli';

export type TurnToolCall = {
  // 'Read' | 'Bash' | 'Edit' | 'Write' | 'Grep' | ... (모델별 휴리스틱)
  tool: string;
  // 파일 경로 또는 명령. 길면 truncate.
  arg: string;
  // 도구 결과 요약 (선택).
  summary?: string;
};

export type TurnRecord = {
  id: string; // uuid v4
  workspaceId: string;
  sessionId: string; // multi-tab 구분
  model: CliKind;
  startedAt: string; // ISO — 사용자 Enter 시점
  completedAt: string; // ISO — PTY idle 후
  user: string; // pty:write buffer flush 정제 (paste/backspace)
  userBytes: number; // 정제 후 길이
  // assistant 본문 정제 결과:
  //   1. ANSI strip
  //   2. 시스템 indicator 제거
  //   3. 도구 호출 박스 추출 → toolCalls[]
  //   4. 남은 본문 = assistantBody
  assistantBody: string;
  assistantBodyBytes: number;
  toolCalls: TurnToolCall[];
};

// cap 정책:
//   - user cap 8K
//   - assistantBody cap: 사용자 설정(TurnsAssistantDetail)에 따라 단계별 다름.
//   - toolCalls.arg cap 500 chars
export const TURN_CAP = {
  userBytes: 8 * 1024,
  assistantBodyChars: 500,
  toolCallArgChars: 500,
} as const;

export type TurnsAssistantDetail = 'full' | 'compact' | 'minimal';

// 사용자 설정의 turnsAssistantDetail 단계별 assistantBody char cap.
//   - full:    raw에 가깝게 보존. 시스템 안정성 위해 hard cap만 적용.
//   - compact: 기본값. 약 5,000자(앞 4,000 + 뒤 1,000) — 정상 turn 한 개를 거의 통째로 담는 양.
//   - minimal: 약 1,000자(앞 800 + 뒤 200) — 디스크 가벼움. 요지 위주, 디테일 일부 손실.
export const TURNS_ASSISTANT_DETAIL_CAP: Record<
  TurnsAssistantDetail,
  { chars: number; headChars: number; tailChars: number }
> = {
  full: { chars: 50_000, headChars: 49_000, tailChars: 1_000 },
  compact: { chars: 5_000, headChars: 4_000, tailChars: 1_000 },
  minimal: { chars: 1_000, headChars: 800, tailChars: 200 },
};

// Compaction trigger:
//   uncompacted count >= 6  OR  sum(userBytes + assistantBodyBytes) >= 192K
// 의도: 최근 `keepRecent`개 raw 보존, oldest 청크를 1개의 IR로 흡수.
// bytesThreshold는 평상시엔 거의 안 켜지는 안전망 — keepRecent개 turn 합보다 충분히 커야
//   매 턴 압축을 피한다(가장 무거운 full 모드 기준으로도 여유). 카운트 6이 평소 배치 주기를 담당.
export const COMPACTION_TRIGGER = {
  countThreshold: 6,
  bytesThreshold: 192 * 1024,
  keepRecent: 3,
} as const;

// turns.jsonl rotate 정책:
//   5MB OR 1000 record 도달 시 archive/turns_<TS>.jsonl.archive로 이동.
//   (Compaction과 별개 — 장기 사용 안전망)
export const TURNS_ROTATE = {
  maxBytes: 5 * 1024 * 1024,
  maxRecords: 1000,
} as const;
