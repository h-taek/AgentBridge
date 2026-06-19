// claude 어댑터 — @anthropic-ai/claude-agent-sdk(ESM)를 지속(멀티턴) 채팅 세션으로 정규화.
// 구조: streaming-input mode — query({prompt: AsyncIterable<SDKUserMessage>})를 한 번 열고(=한 세션),
// send마다 user 메시지를 입력 스트림에 push. 한 Query 제너레이터가 모든 턴의 SDKMessage를 방출하므로
// 맥락이 유지되고 interrupt/setModel 같은 제어가 가능하다(streaming 전용).
// 백그라운드 pump가 SDKMessage→ChatEvent로 매핑해 "현재 턴" 큐에 흘리고, result에서 onTurn(TurnRecord)
// 방출 후 턴을 닫는다. 턴은 직렬(turnGate)이라 ref.current 하나로 라우팅.
// 본문 권위값: TurnRecord의 assistantBody는 최종 assistant 메시지에서만 채운다(델타는 라이브 표시용).
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { OpenTurn, ReaderCtx } from '../transcriptReader/types.js';
import { finalizeTurn, toolArgString } from '../transcriptReader/util.js';
import { AsyncQueue } from './asyncQueue.js';
import type { AgentAdapter, ChatEvent, Session, StartOptions } from './types.js';

type ActiveTurn = { events: AsyncQueue<ChatEvent>; open: OpenTurn };

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  async start(opts: StartOptions): Promise<Session> {
    const input = new AsyncQueue<SDKUserMessage>();
    const q: Query = query({
      prompt: input,
      options: {
        cwd: opts.cwd,
        includePartialMessages: true, // 델타 스트리밍(content_block_delta)
        ...(opts.resume ? { resume: opts.resume } : {}),
      },
    });

    let sessionId = opts.resume ?? '';
    let model: string | undefined;

    // 현재 진행 중인 턴. 턴 직렬(turnGate)이라 단일 슬롯으로 충분.
    // 객체 슬롯으로 보관 — IIFE pump에서 `let` 직접 읽기는 enclosing CFA가 never로 좁히는 TS 이슈를 피함.
    const ref: { current: ActiveTurn | null } = { current: null };

    // 백그라운드 소비 루프.
    const pump = (async () => {
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') {
            sessionId = m.session_id;
            model = m.model;
            // init은 (streaming-input mode) 첫 입력 이후 도착 — 그 시점의 현재 턴에 session 이벤트 방출.
            ref.current?.events.push({ t: 'session', sessionId, model });
            continue;
          }
          const turn = ref.current;
          if (!turn) continue; // 턴 밖 메시지(드묾) — 무시
          if (m.type === 'stream_event') {
            const ev = m.event;
            if (ev.type === 'content_block_delta') {
              if (ev.delta.type === 'text_delta' && ev.delta.text) {
                turn.events.push({ t: 'text', text: ev.delta.text, final: false });
              } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
                turn.events.push({ t: 'thinking', text: ev.delta.thinking });
              }
            }
          } else if (m.type === 'assistant') {
            // 턴 고유 키 — 세션 id는 턴마다 같으므로 충돌. assistant 메시지 uuid가 턴별 안정 키
            // (SDK transcript 기준이라 resume 재방출에도 동일 → dedup 멱등).
            if (!turn.open.sourceKey) turn.open.sourceKey = m.uuid;
            for (const b of m.message.content) {
              if (b.type === 'text') {
                turn.open.assistantParts.push(b.text); // TurnRecord 권위값(델타 아님)
                turn.events.push({ t: 'text', text: b.text, final: true });
              } else if (b.type === 'tool_use') {
                turn.open.toolCalls.push({ tool: b.name, arg: toolArgString(b.input) });
                turn.events.push({ t: 'tool', id: b.id, name: b.name, input: b.input, status: 'started' });
              }
            }
          } else if (m.type === 'result') {
            if (!turn.open.sourceKey) turn.open.sourceKey = m.uuid; // assistant 없던 턴 폴백
            turn.open.lastAt = new Date().toISOString();
            const ctx: ReaderCtx = {
              workspaceId: opts.workspaceId,
              sessionId,
              detail: opts.detail ?? 'compact',
            };
            await opts.onTurn?.(finalizeTurn(turn.open, 'claude', ctx));
            turn.events.push({ t: 'turn_end', reason: m.subtype });
            turn.events.close();
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ref.current?.events.push({ t: 'error', message });
        ref.current?.events.close();
      }
    })();

    // 턴 직렬화 게이트 — 이전 턴이 끝나야 다음 send가 ref.current를 잡는다(라우팅 경쟁 방지).
    let turnGate: Promise<void> = Promise.resolve();

    const send = (text: string): AsyncIterable<ChatEvent> =>
      (async function* () {
        const prev = turnGate;
        let release!: () => void;
        turnGate = new Promise<void>((r) => (release = r));
        await prev;
        try {
          const events = new AsyncQueue<ChatEvent>();
          const open: OpenTurn = {
            sourceKey: '', // 턴별로 assistant/result uuid에서 채움(세션 id는 턴마다 같아 충돌)
            user: text,
            startedAt: new Date().toISOString(),
            lastAt: '',
            assistantParts: [],
            toolCalls: [],
          };
          ref.current = { events, open };
          // sessionId가 이미 있으면(2턴+) 즉시 session 이벤트, 첫 턴은 pump의 init이 방출.
          if (sessionId) events.push({ t: 'session', sessionId, model });
          // 입력을 먼저 push — streaming-input mode는 입력이 와야 init/응답을 방출(ready 선대기 시 데드락).
          input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
          for await (const ev of events) {
            yield ev;
          }
        } finally {
          ref.current = null;
          release();
        }
      })();

    return {
      get sessionId() {
        return sessionId;
      },
      send,
      async interrupt() {
        await q.interrupt();
      },
      async end() {
        input.close();
        await pump;
      },
    };
  },
};
