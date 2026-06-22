// createSerialTurnSession — claude·codex SDK 어댑터가 공유하는 "직렬 턴" 골격.
//   turnGate(이전 턴이 끝나야 다음 send) → events/open 생성 → ref.current 세팅 → begin(엔진별 턴 시작)
//   → events 큐를 ChatEvent로 yield → finally 정리(ref 비움·게이트 해제).
// 엔진 pump(메시지→ChatEvent 매핑 + finalizeTurn/onTurn)는 어댑터가 ref.current로 라우팅하며 별도 소유한다.
// PTY의 CaptureSession이 턴 기계를 한 곳에 모은 것과 같은 모양 — 메커니즘만 라이브-게이트 vs 파일-cursor로 다름.
import type { ChatEvent } from './types.js';
import type { OpenTurn } from '../transcriptReader/types.js';
import { AsyncQueue } from './asyncQueue.js';

// 진행 중인 턴 슬롯. turnId는 codex 인터럽트용(claude는 미사용, 빈 문자열 유지).
export interface ActiveTurn {
  events: AsyncQueue<ChatEvent>;
  open: OpenTurn;
  turnId: string;
}

// begin: ref.current 세팅 직후 호출되는 엔진별 턴 시작.
//   claude=입력 스트림 push / codex=turn/start RPC(+turnId·sourceKey 채움). active.events에 선이벤트(session 등) push 가능.
//   throw하면 골격이 'error' 이벤트로 방출(codex turn/start 거부 등).
export type TurnBegin = (active: ActiveTurn, text: string) => void | Promise<void>;

// ref는 어댑터가 소유(pump가 ref.current로 라우팅) — 여기선 send만 만들어 돌려준다.
export function createSerialTurnSession(
  ref: { current: ActiveTurn | null },
  begin: TurnBegin,
): (text: string) => AsyncIterable<ChatEvent> {
  let turnGate: Promise<void> = Promise.resolve();
  return (text: string): AsyncIterable<ChatEvent> =>
    (async function* () {
      const prev = turnGate;
      let release!: () => void;
      turnGate = new Promise<void>((r) => (release = r));
      await prev;
      const events = new AsyncQueue<ChatEvent>();
      const open: OpenTurn = {
        sourceKey: '', // 턴별로 엔진이 채움(세션 id는 턴마다 같아 충돌)
        user: text,
        startedAt: new Date().toISOString(),
        lastAt: '',
        assistantParts: [],
        toolCalls: [],
      };
      const active: ActiveTurn = { events, open, turnId: '' };
      ref.current = active;
      try {
        await begin(active, text);
        for await (const ev of events) yield ev;
      } catch (err) {
        yield { t: 'error', message: err instanceof Error ? err.message : String(err) };
      } finally {
        ref.current = null;
        release();
      }
    })();
}
