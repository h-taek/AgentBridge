// claude jsonl 레코드 → TurnRecord[]. 순수 함수.
import type { TurnRecord, TurnToolCall } from '../shared/turns';
import type { Carry, ConsumeResult, OpenTurn, ReaderCtx } from './types';
import { finalizeTurn, toolArgString } from './util';

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  promptSource?: string;
  message?: {
    role?: string;
    stop_reason?: string;
    content?: unknown;
  };
}

function isTypedUser(r: ClaudeRecord): r is ClaudeRecord & { message: { content: string } } {
  return (
    r.type === 'user' &&
    r.promptSource === 'typed' &&
    typeof r.message?.content === 'string'
  );
}

function newOpen(r: ClaudeRecord): OpenTurn {
  return {
    sourceKey: r.uuid ?? `noid-${r.timestamp ?? ''}`,
    user: r.message!.content as string,
    startedAt: r.timestamp ?? '',
    lastAt: r.timestamp ?? '',
    assistantParts: [],
    toolCalls: [],
  };
}

export function claudeConsume(
  records: unknown[],
  carry: Carry,
  ctx: ReaderCtx,
): ConsumeResult {
  const turns: TurnRecord[] = [];
  let open = carry.open;
  let turnIndex = carry.turnIndex;
  // tool_use id → 해당 toolCall (다음 tool_result로 summary 채우기용)
  const pendingTool = new Map<string, TurnToolCall>();

  for (const raw of records as ClaudeRecord[]) {
    if (isTypedUser(raw)) {
      if (open) {
        turns.push(finalizeTurn(open, 'claude', ctx));
        turnIndex++;
      }
      open = newOpen(raw);
      pendingTool.clear();
      continue;
    }
    if (!open) continue; // 턴 시작 전 레코드(주입/시작전 tool_result 등) 무시

    if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
      if (raw.timestamp) open.lastAt = raw.timestamp;
      for (const block of raw.message!.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          open.assistantParts.push(block.text);
        } else if (block.type === 'tool_use') {
          const tc: TurnToolCall = {
            tool: String(block.name ?? 'tool'),
            arg: toolArgString(block.input),
          };
          open.toolCalls.push(tc);
          if (typeof block.id === 'string') pendingTool.set(block.id, tc);
        }
        // thinking 등 기타 블록 제외
      }
    } else if (raw.type === 'user' && Array.isArray(raw.message?.content)) {
      // tool_result — 직전 toolCall에 summary 매칭
      if (raw.timestamp) open.lastAt = raw.timestamp;
      for (const block of raw.message!.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const tc = pendingTool.get(block.tool_use_id);
          if (tc) {
            const text =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content ?? '');
            tc.summary = text.slice(0, 200);
          }
        }
      }
    }
  }

  return { turns, carry: { open, turnIndex } };
}
