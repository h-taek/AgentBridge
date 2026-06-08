// claude jsonl 레코드 → TurnRecord[]. 순수 함수.
import type { TurnRecord } from '../shared/turns';
import type { Carry, ConsumeResult, OpenTurn, ReaderCtx } from './types';
import { finalizeTurn, hasTurnContent, toolArgString } from './util';

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
  // 미완 열린 턴의 첫 레코드 인덱스(atomic-read cursor-hold용). 열린 턴 없으면 records.length.
  // carry.open이 들어왔으면 이 버퍼 전체가 그 턴 연장이므로 0(매니저는 EMPTY_CARRY로 호출 → 보통 records.length 시작).
  let openStart = carry.open ? 0 : records.length;

  const list = records as ClaudeRecord[];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (isTypedUser(raw)) {
      if (open) {
        // 끊긴 턴(완료 신호 없이 다음 user 옴) — 내용 있으면 보존, 빈 채면 skip(빈-턴 규칙).
        if (hasTurnContent(open)) turns.push(finalizeTurn(open, 'claude', ctx));
        turnIndex++;
      }
      open = newOpen(raw);
      openStart = i; // 이 user 레코드가 새 턴(미완) 시작
      continue;
    }
    if (!open) continue; // 턴 시작 전 레코드(주입/시작전 tool_result 등) 무시

    if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
      if (raw.timestamp) open.lastAt = raw.timestamp;
      let hadText = false;
      for (const block of raw.message!.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          open.assistantParts.push(block.text);
          hadText = true;
        } else if (block.type === 'tool_use') {
          open.toolCalls.push({ tool: String(block.name ?? 'tool'), arg: toolArgString(block.input) });
          // tool_use id → 인덱스. carry에 영속돼 다음 user의 tool_result와 증분 tick 경계 넘어 매칭.
          if (typeof block.id === 'string') (open.toolCallById ??= {})[block.id] = open.toolCalls.length - 1;
        }
        // thinking 등 기타 블록 제외
      }
      // 턴 끝 신호: claude는 한 어시스턴트 메시지를 블록별 레코드(thinking/text/tool_use)로 쪼개 쓰고
      // stop_reason을 그 메시지의 전 레코드에 복제한다. thinking 레코드도 end_turn을 달고 text보다 먼저
      // 오므로, end_turn만 보고 마감하면 뒤따르는 답변 text를 빈 채로 마감해 잃는다(실데이터 재현).
      // → 답변 text가 실린 레코드의 end_turn에서만 마감(실시간 flush). 끊긴 턴은 다음 user/finalize가 처리.
      if (raw.message?.stop_reason === 'end_turn' && hadText) {
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

  return { turns, carry: { open, turnIndex }, consumed: open ? openStart : list.length };
}
