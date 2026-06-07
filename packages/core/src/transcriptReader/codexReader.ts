// codex jsonl(response_item) → TurnRecord[]. 순수 함수. 단일 스트림.
import type { TurnRecord, TurnToolCall } from '../shared/turns';
import type { Carry, ConsumeResult, ReaderCtx } from './types';
import { finalizeTurn, toolArgString } from './util';

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
  };
}

const INJECT_MARKERS = ['<environment_context>', '<agentbridge-context>'];

function messageText(p: NonNullable<CodexRecord['payload']>): string {
  return (p.content ?? []).map((c) => c.text ?? '').join('');
}

function isRealUser(p: NonNullable<CodexRecord['payload']>): boolean {
  if (p.type !== 'message' || p.role !== 'user') return false;
  const t = messageText(p).trimStart();
  return !INJECT_MARKERS.some((m) => t.startsWith(m));
}

export function codexConsume(
  records: unknown[],
  carry: Carry,
  ctx: ReaderCtx,
): ConsumeResult {
  const turns: TurnRecord[] = [];
  let open = carry.open;
  let turnIndex = carry.turnIndex;
  const pendingTool = new Map<string, TurnToolCall>();

  for (const raw of records as CodexRecord[]) {
    const p = raw.payload;
    if (!p) continue;

    // 턴 끝 신호: event_msg/task_complete → 에이전트 응답 종료. 다음 user 안 기다리고 즉시 마감.
    if (raw.type === 'event_msg' && p.type === 'task_complete') {
      if (open) {
        turns.push(finalizeTurn(open, 'codex', ctx));
        turnIndex++;
        open = null;
        pendingTool.clear();
      }
      continue;
    }

    if (isRealUser(p)) {
      if (open) {
        turns.push(finalizeTurn(open, 'codex', ctx));
        turnIndex++;
      }
      open = {
        sourceKey: `${ctx.sessionId}#${turnIndex}`,
        user: messageText(p),
        startedAt: raw.timestamp ?? '',
        lastAt: raw.timestamp ?? '',
        assistantParts: [],
        toolCalls: [],
      };
      pendingTool.clear();
      continue;
    }
    if (!open) continue;
    if (raw.timestamp) open.lastAt = raw.timestamp;

    if (p.type === 'message' && p.role === 'assistant') {
      const text = (p.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join('');
      if (text) open.assistantParts.push(text);
    } else if (p.type === 'function_call') {
      const tc: TurnToolCall = {
        tool: String(p.name ?? 'tool'),
        arg: toolArgString(p.arguments ?? ''),
      };
      open.toolCalls.push(tc);
      if (p.call_id) pendingTool.set(p.call_id, tc);
    } else if (p.type === 'function_call_output' && p.call_id) {
      const tc = pendingTool.get(p.call_id);
      if (tc && typeof p.output === 'string') tc.summary = p.output.slice(0, 200);
    }
  }

  return { turns, carry: { open, turnIndex } };
}
