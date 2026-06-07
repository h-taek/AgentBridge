// claude jsonl 레코드 → TurnRecord[]. 순수 함수.
import type { TurnRecord } from '../shared/turns';
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
    toolCallById: {},
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

  for (const raw of records as ClaudeRecord[]) {
    if (isTypedUser(raw)) {
      if (open) {
        turns.push(finalizeTurn(open, 'claude', ctx));
        turnIndex++;
      }
      open = newOpen(raw);
      continue;
    }
    if (!open) continue; // 턴 시작 전 레코드(주입/시작전 tool_result 등) 무시

    if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
      if (raw.timestamp) open.lastAt = raw.timestamp;
      for (const block of raw.message!.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          open.assistantParts.push(block.text);
        } else if (block.type === 'tool_use') {
          open.toolCalls.push({ tool: String(block.name ?? 'tool'), arg: toolArgString(block.input) });
          // tool_use id → 인덱스. carry에 영속돼 다음 user의 tool_result와 증분 tick 경계 넘어 매칭.
          if (typeof block.id === 'string') (open.toolCallById ??= {})[block.id] = open.toolCalls.length - 1;
        }
        // thinking 등 기타 블록 제외
      }
      // 턴 끝 신호: stop_reason=end_turn → 다음 user를 안 기다리고 즉시 마감(실시간 flush).
      // 결정적 id라 재읽기/재flush는 하류에서 dedup. 끊긴 턴(end_turn 없음)은 다음 user/finalize가 처리.
      if (raw.message?.stop_reason === 'end_turn') {
        turns.push(finalizeTurn(open, 'claude', ctx));
        turnIndex++;
        open = null;
      }
    } else if (raw.type === 'user' && Array.isArray(raw.message?.content)) {
      // tool_result — 직전 toolCall에 summary 매칭
      if (raw.timestamp) open.lastAt = raw.timestamp;
      for (const block of raw.message!.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const idx = open.toolCallById?.[block.tool_use_id];
          if (idx !== undefined && open.toolCalls[idx]) {
            const text =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content ?? '');
            open.toolCalls[idx].summary = text.slice(0, 200);
          }
        }
      }
    }
  }

  return { turns, carry: { open, turnIndex } };
}
