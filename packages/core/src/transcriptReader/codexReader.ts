// codex jsonl(response_item) → TurnRecord[]. 순수 함수. 단일 스트림.
import type { TurnRecord } from '../shared/turns';
import type { Carry, ConsumeResult, ReaderCtx } from './types';
import { finalizeTurn, hasTurnContent, toolArgString } from './util';
import { CONTEXT_TAG_NAME_PREFIX } from '../contextTag';

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

// 실사용자 턴이 아닌 user-role 메시지 prefix. 주입 컨텍스트 + codex가 인터럽트 시 남기는
// "<turn_aborted>…" 센티넬. 안 거르면 인터럽트 때 user="<turn_aborted>…"인 가짜 턴이 생긴다
// (보통 빈-턴 skip이 막지만, 그 뒤에 내용이 붙으면 새므로 명시적으로 차단). 인터럽트 자체는
// 턴을 닫는 신호로 쓰지 않는다 — 미완 턴은 다음 user/finalize가 처리(설계).
// agentbridge 항목은 닫는 `>` 없이 이름까지만 — 새 sentinel OPEN(`<agentbridge-context k="…">`)과
// 옛 plain(`<agentbridge-context>`) 양쪽을 같은 startsWith로 잡는다(B-005 wire 변경 backward compat).
const NON_USER_PREFIXES = ['<environment_context>', CONTEXT_TAG_NAME_PREFIX, '<turn_aborted>'];

function messageText(p: NonNullable<CodexRecord['payload']>): string {
  return (p.content ?? []).map((c) => c.text ?? '').join('');
}

function isRealUser(p: NonNullable<CodexRecord['payload']>): boolean {
  if (p.type !== 'message' || p.role !== 'user') return false;
  const t = messageText(p).trimStart();
  return !NON_USER_PREFIXES.some((m) => t.startsWith(m));
}

export function codexConsume(
  records: unknown[],
  carry: Carry,
  ctx: ReaderCtx,
): ConsumeResult {
  const turns: TurnRecord[] = [];
  let open = carry.open;
  let turnIndex = carry.turnIndex;
  let openStart = carry.open ? 0 : records.length; // 미완 열린 턴 첫 레코드 인덱스(atomic-read cursor-hold)

  const list = records as CodexRecord[];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const p = raw.payload;
    if (!p) continue;

    // 턴 끝 신호: event_msg/task_complete → 에이전트 응답 종료. 다음 user 안 기다리고 즉시 마감.
    if (raw.type === 'event_msg' && p.type === 'task_complete') {
      if (open) {
        if (hasTurnContent(open)) turns.push(finalizeTurn(open, 'codex', ctx));
        turnIndex++;
        open = null;
      }
      continue;
    }

    if (isRealUser(p)) {
      if (open) {
        // 끊긴 턴 — 내용 있으면 보존, 빈 채면 skip(빈-턴 규칙).
        if (hasTurnContent(open)) turns.push(finalizeTurn(open, 'codex', ctx));
        turnIndex++;
      }
      open = {
        // codex user 레코드엔 고유 id가 없어 timestamp를 턴 키로(cursor-hold 재읽기 시 id 재현용).
        // timestamp 없는 합성 입력은 turnIndex로 폴백.
        sourceKey: `${ctx.sessionId}#${raw.timestamp ?? turnIndex}`,
        user: messageText(p),
        startedAt: raw.timestamp ?? '',
        lastAt: raw.timestamp ?? '',
        assistantParts: [],
        toolCalls: [],
        toolCallById: {},
      };
      openStart = i; // 이 user 레코드가 새 턴(미완) 시작
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
      open.toolCalls.push({ tool: String(p.name ?? 'tool'), arg: toolArgString(p.arguments ?? '') });
      // call_id → 방금 push한 인덱스. carry에 영속돼 다음 consume의 결과와도 매칭(증분 tick 경계 생존).
      if (p.call_id) (open.toolCallById ??= {})[p.call_id] = open.toolCalls.length - 1;
    } else if (p.type === 'function_call_output' && p.call_id && typeof p.output === 'string') {
      const idx = open.toolCallById?.[p.call_id];
      if (idx !== undefined && open.toolCalls[idx]) open.toolCalls[idx].summary = p.output.slice(0, 200);
    }
  }

  return { turns, carry: { open, turnIndex }, consumed: open ? openStart : list.length };
}
