// agy step 행(protobuf payload) → TurnRecord[]. 순수 함수.
//
// agy step_payload는 평문 protobuf이며 내용이 래퍼 메시지 안에 중첩돼 있다(실측):
//   step_type 14 (user)         : f19 → f2  (사용자 텍스트)
//   step_type 15 (assistant)    : f20 → f1  (텍스트)  또는  f20 → f7 → {f1=호출id, f2=도구명, f3=인자} (도구 호출)
//   도구 실행/결과 (8, 21, …)    : f5 → f4 → f1 (호출id),  f5 → f31 (요약)
//   step_type 90/101/98/23      : 주입 컨텍스트·시스템 알림·마커 → 필터
// 도구 실행 step_type은 도구마다 달라(8=view_file, 21=run_command, …) 열거하지 않고
// 호출 id(f1)로 step_type 15의 도구 호출과 페어링한다. (design §C, 실측 검증)

import type { TurnToolCall } from '../shared/turns';
import type { Carry, ConsumeResult, OpenTurn, ReaderCtx, TurnRecord } from './types';
import { finalizeTurn, toolArgString } from './util';
import { decodeProtobuf, topLevelString } from './protobuf';

export interface AgyStepRow {
  idx: number;
  stepType: number;
  payload: Buffer;
}

const FILTER_TYPES = new Set([90, 101, 98, 23]);
const USER_TYPE = 14;
const ASSISTANT_TYPE = 15;

// 첫 번째 length-delimited 필드(중첩 메시지)의 바이트를 반환.
function subMessage(payload: Buffer, field: number): Buffer | null {
  for (const f of decodeProtobuf(payload)) {
    if (f.field === field && f.kind === 'bytes') return f.value as Buffer;
  }
  return null;
}

function userText(payload: Buffer): string {
  const m = subMessage(payload, 19);
  return (m && topLevelString(m, 2)) || '';
}

// step_type 15 → 도구 호출이면 {tool, callId}, 텍스트면 {text}. 둘 다 없으면 null.
function parseAssistantStep(
  payload: Buffer,
): { tool: TurnToolCall; callId: string | null } | { text: string } | null {
  const m = subMessage(payload, 20);
  if (!m) return null;
  const tool = subMessage(m, 7);
  if (tool) {
    const name = topLevelString(tool, 2);
    if (!name) return null;
    const tc: TurnToolCall = { tool: name, arg: toolArgString(topLevelString(tool, 3) ?? '') };
    return { tool: tc, callId: topLevelString(tool, 1) };
  }
  const text = topLevelString(m, 1) ?? topLevelString(m, 8);
  return text ? { text } : null;
}

// 도구 실행/결과 step → 호출 id(f5→f4→f1)와 요약(f5→f31).
function parseExecStep(payload: Buffer): { callId: string | null; summary: string | null } {
  const m = subMessage(payload, 5);
  if (!m) return { callId: null, summary: null };
  const meta = subMessage(m, 4);
  const callId = meta ? topLevelString(meta, 1) : null;
  return { callId, summary: topLevelString(m, 31) };
}

export function agyConsume(rows: AgyStepRow[], carry: Carry, ctx: ReaderCtx): ConsumeResult {
  const turns: TurnRecord[] = [];
  let open: OpenTurn | null = carry.open;
  let turnIndex = carry.turnIndex;
  const pendingTool = new Map<string, TurnToolCall>();

  for (const row of rows) {
    if (FILTER_TYPES.has(row.stepType)) continue;

    if (row.stepType === USER_TYPE) {
      if (open) {
        turns.push(finalizeTurn(open, 'agy', ctx));
        turnIndex++;
      }
      open = {
        sourceKey: `${ctx.sessionId}#${row.idx}`,
        user: userText(row.payload),
        startedAt: '',
        lastAt: '',
        assistantParts: [],
        toolCalls: [],
      };
      pendingTool.clear();
      continue;
    }
    if (!open) continue;

    if (row.stepType === ASSISTANT_TYPE) {
      const parsed = parseAssistantStep(row.payload);
      if (!parsed) continue;
      if ('tool' in parsed) {
        open.toolCalls.push(parsed.tool);
        if (parsed.callId) pendingTool.set(parsed.callId, parsed.tool);
      } else {
        open.assistantParts.push(parsed.text);
      }
    } else {
      // 도구 실행/결과 step (8, 21, …) — 호출 id로 summary 보강
      const { callId, summary } = parseExecStep(row.payload);
      if (callId && summary) {
        const tc = pendingTool.get(callId);
        if (tc) tc.summary = summary.slice(0, 200);
      }
    }
  }

  return { turns, carry: { open, turnIndex } };
}
