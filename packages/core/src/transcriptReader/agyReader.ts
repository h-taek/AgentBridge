// agy transcript.jsonl 레코드 → TurnRecord[]. 순수 함수. claude/codex와 동일한 jsonl reader 인터페이스.
// 소스: ~/.gemini/antigravity-cli/brain/<convUUID>/.system_generated/logs/transcript.jsonl
//   - 각 스텝 "완료" 시 한 줄씩 append (status는 항상 DONE — 라이브 검증).
//   - user 턴:  type=USER_INPUT + source=USER_EXPLICIT (content는 <USER_REQUEST>…</USER_REQUEST>로 감싸짐).
//   - 주입:     source=SYSTEM(CONVERSATION_HISTORY 등) → 무시.
//   - 도구 호출: type=PLANNER_RESPONSE + tool_calls 있음 (content 없음).
//   - 도구 결과: 도구별 type(LIST_DIRECTORY/VIEW_FILE 등) + content → 직전 도구 호출 summary.
//   - 턴 끝(즉시 flush): type=PLANNER_RESPONSE + content 있음 + tool_calls 없음 = 사용자에게 보내는 최종 답변.
//     (라이브 검증: 중간 스텝은 content 없거나 tool_calls 있음 → 오탐 0. thinking은 별도 필드라 content에 안 섞임.)
import type { Carry, ConsumeResult, ReaderCtx, TurnRecord } from './types';
import { finalizeTurn, hasTurnContent, toolArgString } from './util';

interface AgyRecord {
  step_index?: number;
  type?: string;
  source?: string;
  status?: string;
  content?: string | null;
  thinking?: string | null;
  tool_calls?: Array<{ name?: string; args?: unknown }> | null;
}

// <USER_REQUEST>…</USER_REQUEST>로 감싼 실제 질문만 추출(메타데이터 블록 제외). 태그 없으면 원문 trim.
function extractUserRequest(content: string): string {
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (m ? m[1] : content).trim();
}

function isRealUser(r: AgyRecord): boolean {
  return r.type === 'USER_INPUT' && r.source === 'USER_EXPLICIT';
}

function hasText(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

export function agyConsume(records: unknown[], carry: Carry, ctx: ReaderCtx): ConsumeResult {
  const turns: TurnRecord[] = [];
  let open = carry.open;
  let turnIndex = carry.turnIndex;
  let openStart = carry.open ? 0 : records.length; // 미완 열린 턴 첫 레코드 인덱스(atomic-read cursor-hold)

  const list = records as AgyRecord[];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (isRealUser(raw)) {
      if (open) {
        // 끊긴 턴 — 내용 있으면 보존, 빈 채면 skip(빈-턴 규칙).
        if (hasTurnContent(open)) turns.push(finalizeTurn(open, 'agy', ctx));
        turnIndex++;
      }
      open = {
        sourceKey: `${ctx.sessionId}#${raw.step_index ?? turnIndex}`,
        user: extractUserRequest(raw.content ?? ''),
        startedAt: '',
        lastAt: '',
        assistantParts: [],
        toolCalls: [],
      };
      openStart = i; // 이 USER_INPUT 레코드가 새 턴(미완) 시작
      continue;
    }
    if (raw.source === 'SYSTEM') continue; // 주입(CONVERSATION_HISTORY 등) 무시
    if (!open) continue;

    if (raw.type === 'PLANNER_RESPONSE') {
      const tools = raw.tool_calls ?? [];
      if (tools.length > 0) {
        // 중간 스텝: 도구 호출 (content는 보통 null, thinking은 무시)
        for (const tc of tools) {
          open.toolCalls.push({ tool: String(tc.name ?? 'tool'), arg: toolArgString(tc.args) });
        }
      } else if (hasText(raw.content)) {
        // 최종 답변(도구 없음 + content 있음) = 턴 끝 → 즉시 flush. thinking은 제외.
        open.assistantParts.push(raw.content);
        turns.push(finalizeTurn(open, 'agy', ctx));
        turnIndex++;
        open = null;
      }
      // content/tool_calls 둘 다 없으면(생각만) skip
      continue;
    }

    // 도구 결과 레코드(LIST_DIRECTORY/VIEW_FILE 등): content를 직전 도구 호출 summary로.
    if (raw.source === 'MODEL' && hasText(raw.content)) {
      const last = open.toolCalls[open.toolCalls.length - 1];
      if (last && last.summary === undefined) last.summary = raw.content.slice(0, 200);
    }
  }

  return { turns, carry: { open, turnIndex }, consumed: open ? openStart : list.length };
}
