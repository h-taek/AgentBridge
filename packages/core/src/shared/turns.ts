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
  // sliceAssistant 휴리스틱 결과:
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
//   - compact: 기본값. 약 500자(앞 400 + 뒤 100) 요약 — IR refine에 균형 잡힌 양.
//   - minimal: 약 200자 — 디스크 가벼움. 디테일 손실.
export const TURNS_ASSISTANT_DETAIL_CAP: Record<
  TurnsAssistantDetail,
  { chars: number; headChars: number; tailChars: number }
> = {
  full: { chars: 50_000, headChars: 49_000, tailChars: 1_000 },
  compact: { chars: 500, headChars: 400, tailChars: 100 },
  minimal: { chars: 200, headChars: 150, tailChars: 50 },
};

// Compaction trigger:
//   uncompacted count >= 6  OR  sum(userBytes + assistantBodyBytes) >= 12K
// 의도: 최근 `keepRecent`개 raw 보존, oldest 청크를 1개의 IR로 흡수.
export const COMPACTION_TRIGGER = {
  countThreshold: 6,
  bytesThreshold: 12 * 1024,
  keepRecent: 3,
} as const;

// turns.jsonl rotate 정책:
//   5MB OR 1000 record 도달 시 archive/turns_<TS>.jsonl.archive로 이동.
//   (Compaction과 별개 — 장기 사용 안전망)
export const TURNS_ROTATE = {
  maxBytes: 5 * 1024 * 1024,
  maxRecords: 1000,
} as const;
