// claude 어댑터 — @anthropic-ai/claude-agent-sdk(ESM) 이벤트를 ChatEvent 스트림 + TurnRecord로 정규화.
// 코어 finalizeTurn 재사용(cap/byte 정책 그대로) → seam 하류(appendTurn→compaction→IR) 무변경.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OpenTurn, ReaderCtx } from '../transcriptReader/types.js';
import { finalizeTurn, toolArgString } from '../transcriptReader/util.js';
import type { AgentAdapter, ChatEvent, Session, StartOptions } from './types.js';

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  async start(opts: StartOptions): Promise<Session> {
    let sessionId = '';

    const send = async function* (text: string): AsyncIterable<ChatEvent> {
      const open: OpenTurn = {
        sourceKey: '',
        user: text,
        startedAt: new Date().toISOString(),
        lastAt: '',
        assistantParts: [],
        toolCalls: [],
      };
      try {
        for await (const m of query({ prompt: text })) {
          if (m.type === 'system' && m.subtype === 'init') {
            sessionId = m.session_id;
            open.sourceKey = m.session_id;
            yield { t: 'session', sessionId, model: m.model };
          } else if (m.type === 'assistant') {
            for (const b of m.message.content) {
              if (b.type === 'text') {
                open.assistantParts.push(b.text);
                yield { t: 'text', text: b.text, final: false };
              } else if (b.type === 'tool_use') {
                open.toolCalls.push({ tool: b.name, arg: toolArgString(b.input) });
                yield { t: 'tool', id: b.id, name: b.name, input: b.input, status: 'started' };
              }
            }
          } else if (m.type === 'result') {
            open.lastAt = new Date().toISOString();
            yield { t: 'turn_end', reason: m.subtype };
          }
        }
      } catch (err) {
        yield { t: 'error', message: err instanceof Error ? err.message : String(err) };
      }

      const ctx: ReaderCtx = {
        workspaceId: opts.workspaceId,
        sessionId: sessionId || open.sourceKey,
        detail: opts.detail ?? 'compact',
      };
      await opts.onTurn?.(finalizeTurn(open, 'claude', ctx));
    };

    return {
      get sessionId() {
        return sessionId;
      },
      send,
    };
  },
};
