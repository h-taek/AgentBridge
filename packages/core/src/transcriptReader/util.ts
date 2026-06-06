// transcriptReader 공용 헬퍼. ANSI/chrome 휴리스틱 없음 — 깨끗한 텍스트 전제.
import type { CliKind } from '../shared/cli';
import type { TurnRecord, TurnsAssistantDetail } from '../shared/turns';
import { TURN_CAP, TURNS_ASSISTANT_DETAIL_CAP } from '../shared/turns';
import type { OpenTurn, ReaderCtx } from './types';

// 플랫폼 중립 UTF-8 byte length (Buffer/TextEncoder 비의존).
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// detail 단계별 head+tail cap (결론부 보존). sliceAssistant의 cap 의미 그대로.
export function applyDetailCap(body: string, detail: TurnsAssistantDetail): string {
  const { chars, headChars, tailChars } = TURNS_ASSISTANT_DETAIL_CAP[detail];
  if (body.length <= chars) return body;
  if (tailChars <= 0) return body.slice(0, headChars);
  return body.slice(0, headChars) + '\n…[truncated]…\n' + body.slice(body.length - tailChars);
}

// 결정적 turn id — 재읽기 멱등성의 근거. 소스 고유키 기반(랜덤 아님).
export function deterministicTurnId(model: CliKind, sourceKey: string): string {
  return `${model}:${sourceKey}`;
}

// tool 인자를 표시용 문자열로. 객체면 JSON, 길면 cap.
export function toolArgString(input: unknown): string {
  let s = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (s.length > TURN_CAP.toolCallArgChars) s = s.slice(0, TURN_CAP.toolCallArgChars) + '…';
  return s;
}

function applyUserCap(text: string): string {
  if (utf8ByteLength(text) <= TURN_CAP.userBytes) return text;
  // 문자 단위로 잘라 byte cap 근사 (정확 byte 컷은 불필요 — 안전 상한).
  let cut = text.length;
  while (cut > 0 && utf8ByteLength(text.slice(0, cut)) > TURN_CAP.userBytes) cut -= 64;
  return text.slice(0, Math.max(0, cut)) + '…[truncated]';
}

// 진행 중 OpenTurn을 완성된 TurnRecord로. 모든 reader 공통 마무리.
export function finalizeTurn(open: OpenTurn, model: CliKind, ctx: ReaderCtx): TurnRecord {
  const user = applyUserCap(open.user);
  const assistantBody = applyDetailCap(open.assistantParts.join('\n').trim(), ctx.detail);
  return {
    id: deterministicTurnId(model, open.sourceKey),
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    model,
    startedAt: open.startedAt || open.lastAt || '',
    completedAt: open.lastAt || open.startedAt || '',
    user,
    userBytes: utf8ByteLength(user),
    assistantBody,
    assistantBodyBytes: utf8ByteLength(assistantBody),
    toolCalls: open.toolCalls,
  };
}
