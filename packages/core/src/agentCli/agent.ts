// 서브에이전트 명령 여섯 (0.5.0 4단계 W4, B-5·B-6).
//
// 두 갈래로 갈린다. 기준은 PTY를 만지느냐다.
//   호스트를 부르는 것: start·send·stop·close  — PTY를 만들고 입력하고 끝낸다
//   혼자 끝내는 것:     list·read·check        — 우리 폴더의 파일만 읽는다
// 이 구분은 내부의 것이라 모델이 읽는 명령 목록에는 드러나지 않는다.
//
// 출력은 사람이 읽는 텍스트다(B-5). 소비자가 모델이라 그대로 맥락에 들어가는 편이 낫다.

import { promises as fsp } from 'fs';
import { join } from 'path';
import type { CliKind } from '../shared/cli';
import { readAllTurns } from '../turnsStore';
import {
  computeSessionActivity,
  readSessionActivityInputs,
  type SessionActivity,
} from '../sessionStatus';
import { isUnread, markReported } from '../agent/reportState';
import {
  sendHostRequest,
  HOST_AGENT_START,
  HOST_AGENT_SEND,
  HOST_AGENT_STOP,
  HOST_AGENT_CLOSE,
  type HostRequest,
} from '../hostRequest';

// `--wait`의 기본 상한. 1분인 이유는 백그라운드로 던지지 않은 메인도 하니스의 셸 도구 제한
// 안에서 우리 반환을 받게 하기 위해서다. 긴 서브를 백그라운드로 던진 메인은 `--for`로 늘린다.
export const DEFAULT_WAIT_SEC = 60;
const WAIT_POLL_MS = 1000;

// 빈손으로 돌아올 때 함께 내는 화면 기록의 꼬리. 우리는 파싱하지 않고 그대로 넘긴다 —
// 판단은 메인이 한다(B-6).
const TAIL_BYTES = 2000;

// ─── 레코드에서 서브를 모은다 ────────────────────────────────────────────

interface SessionRecord {
  sessionId: string;
  model: CliKind;
  closedAt: string | null;
  title?: string;
  parentSessionId?: string;
  agentName?: string;
  cleanedAt?: string;
}

export interface SubRow {
  name: string;
  sessionId: string;
  model: CliKind;
  title: string;
  closed: boolean;
  unread: boolean;
  // 관측한 활동. 트리의 행 표시와 같은 판정을 쓴다 — 우리가 따로 매기는 값이 아니다(B-2).
  activity: SessionActivity;
}

async function readSessions(wsDir: string): Promise<SessionRecord[]> {
  try {
    const raw = await fsp.readFile(join(wsDir, 'workspace.json'), 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: SessionRecord[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

// 부르는 세션의 자식만 본다. 남의 서브는 목록에도 안 나오고 만질 수도 없다.
export async function listSubs(wsDir: string, callerSessionId: string): Promise<SubRow[]> {
  const sessions = await readSessions(wsDir);
  // 정리된 서브는 목록에서 뺀다. 레코드는 이름 이력으로만 남는다 (0.5.0 B-7).
  const mine = sessions.filter(
    (s) => s.parentSessionId === callerSessionId && s.agentName && !s.cleanedAt,
  );
  return Promise.all(
    mine.map(async (s) => {
      const closed = s.closedAt !== null;
      // 닫힌 세션에는 상태가 없다 — PTY가 죽었으므로 진행 중일 수도 뒤늦게 완료될 수도 없다.
      const activity: SessionActivity = closed
        ? 'idle'
        : computeSessionActivity(await readSessionActivityInputs(wsDir, s.sessionId), Date.now());
      return {
        name: s.agentName as string,
        sessionId: s.sessionId,
        model: s.model,
        title: s.title ?? s.model,
        closed,
        unread: await isUnread(wsDir, s.sessionId),
        activity,
      };
    }),
  );
}

async function findSub(wsDir: string, callerSessionId: string, name: string): Promise<SubRow> {
  const subs = await listSubs(wsDir, callerSessionId);
  const found = subs.find((s) => s.name === name);
  if (!found) {
    const known = subs.map((s) => s.name).join(', ') || '(없음)';
    throw new Error(`그런 서브가 없다: ${name}. 지금 있는 것: ${known}`);
  }
  return found;
}

// ─── list ───────────────────────────────────────────────────────────────

// 상태 문구. '모름'은 우리가 더는 말할 수 없게 된 자리다 — 출력이 한참 멈췄거나 프로세스가
// 사라졌는데 완료 신호가 없는 경우가 함께 들어간다(B-2). 사용자가 턴을 끊었을 때가 여기 걸린다.
function stateText(s: SubRow): string {
  if (s.closed) return '끝남';
  switch (s.activity) {
    case 'running':
      return '도는 중';
    case 'unknown':
      return '모름 — 출력이 멈춘 지 오래다. 끊겼을 수 있으니 열어 보거나 지침을 다시 보낸다';
    case 'done':
      return '턴 끝남';
    default:
      return '노는 중';
  }
}

function rowLine(s: SubRow): string {
  const mark = s.unread ? '  · 안 읽은 보고 있음' : '';
  return `  ${s.name}  (${s.model}, ${stateText(s)})  ${s.title}${mark}`;
}

export async function agentList(wsDir: string, callerSessionId: string): Promise<string> {
  const subs = await listSubs(wsDir, callerSessionId);
  if (subs.length === 0) return '띄운 서브가 없다.';
  return [`## 서브 ${subs.length}개`, '', ...subs.map(rowLine)].join('\n');
}

// ─── read ───────────────────────────────────────────────────────────────

// 서브의 기록은 그 세션 폴더에 쌓인다(B-8). 사용자가 서브에 직접 건 말도 여기 들어 있다.
export async function agentRead(
  wsDir: string,
  callerSessionId: string,
  name: string,
  lastN?: number,
): Promise<string> {
  const sub = await findSub(wsDir, callerSessionId, name);
  const sessionDir = join(wsDir, 'sessions', sub.sessionId);
  const all = await readAllTurns(sessionDir);

  // 읽음 표시를 쓰는 것은 이 명령뿐이다. 대기의 반환이 끄면 그 직후 턴이 중단됐을 때 알림이
  // 어디에도 다시 나타나지 않는다 — 실제로 가져간 시점에 꺼야 읽기 전까지 리마인드가 붙는다.
  await markReported(wsDir, sub.sessionId);

  if (all.length === 0) {
    return `${name}: 아직 기록된 턴이 없다.${sub.closed ? ' 세션은 이미 끝났다.' : ''}`;
  }
  const turns = typeof lastN === 'number' ? all.slice(-lastN) : all;
  const lines = [`## ${name} (${sub.model}) 의 기록 — ${turns.length}턴, 오래된 것부터`, ''];
  for (const t of turns) {
    lines.push(`[${t.completedAt || ''}]`);
    lines.push(`user: ${t.user || ''}`);
    lines.push(`assistant: ${t.assistantBody || ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── check ──────────────────────────────────────────────────────────────

export interface CheckOptions {
  wait?: boolean;
  forSec?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 화면 기록의 꼬리. 없으면 빈 문자열.
async function replayTail(wsDir: string, sessionId: string): Promise<string> {
  const path = join(wsDir, 'sessions', sessionId, 'replay.log');
  try {
    const stat = await fsp.stat(path);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const handle = await fsp.open(path, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      await handle.read(buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function renderDone(done: SubRow[]): string {
  const lines = [`## 끝난 서브 ${done.length}개`, ''];
  for (const s of done) lines.push(`  ${s.name}  (${s.model})  ${s.title}`);
  lines.push('', '`agent read <이름>`으로 보고를 읽는다.');
  return lines.join('\n');
}

// 빈손으로 돌아오는 것은 두 가지를 가리지 않는다 — 아직 일하는 중일 수도, 신호 없이 끝났을
// 수도 있다. 그래서 가르는 재료를 함께 낸다(B-6). 판단은 메인이 한다.
async function renderEmpty(wsDir: string, subs: SubRow[], waited: boolean): Promise<string> {
  if (subs.length === 0) return '띄운 서브가 없다.';
  const lines = [waited ? '기다리는 동안 끝난 서브가 없다.' : '끝났는데 안 읽은 서브가 없다.', ''];
  for (const s of subs) {
    lines.push(`  ${s.name}  (${s.model}, ${stateText(s)})`);
    if (s.closed) {
      const tail = await replayTail(wsDir, s.sessionId);
      if (tail) {
        lines.push('    — 완료 신호 없이 끝났다. 화면 기록의 꼬리:');
        for (const l of tail.split('\n').slice(-8)) lines.push(`      ${l.replace(/\s+$/, '')}`);
      } else {
        lines.push('    — 완료 신호 없이 끝났다. 화면 기록이 없다.');
      }
    }
  }
  return lines.join('\n');
}

export async function agentCheck(
  wsDir: string,
  callerSessionId: string,
  opts: CheckOptions = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  // 기다리기 전에 먼저 확인한다. 메인이 항상 대기 중인 것은 아니어서 부르기 전에 이미 끝나
  // 있는 서브가 있을 수 있고, 기다리기부터 시작하면 그것을 놓친다(B-6).
  let subs = await listSubs(wsDir, callerSessionId);
  let done = subs.filter((s) => s.unread);
  if (done.length > 0) return renderDone(done);
  if (!opts.wait) return renderEmpty(wsDir, subs, false);

  const deadline = now() + (opts.forSec ?? DEFAULT_WAIT_SEC) * 1000;
  while (now() < deadline) {
    await sleep(WAIT_POLL_MS);
    subs = await listSubs(wsDir, callerSessionId);
    done = subs.filter((s) => s.unread);
    // 조건이 이뤄지면 즉시 반환한다. 상한은 고정된 대기 시간이 아니라 한 번의 호출이
    // 기다리는 최대 시간이다.
    if (done.length > 0) return renderDone(done);
  }
  return renderEmpty(wsDir, subs, true);
}

// ─── 호스트를 부르는 넷 ──────────────────────────────────────────────────

let requestSeq = 0;

function newRequest(kind: string, payload: unknown): HostRequest {
  requestSeq += 1;
  return { id: `${process.pid}-${Date.now()}-${requestSeq}`, kind, at: Date.now(), payload };
}

async function callHost(sessionDir: string | undefined, kind: string, payload: unknown): Promise<string> {
  if (!sessionDir) {
    return '이 세션의 자리를 알 수 없어 호스트에 요청을 넘기지 못했다.';
  }
  const result = await sendHostRequest(sessionDir, newRequest(kind, payload));
  return result.output;
}

export function agentStart(
  sessionDir: string | undefined,
  prompt: string,
  harnesses: string[],
  isolate: boolean,
): Promise<string> {
  return callHost(sessionDir, HOST_AGENT_START, { prompt, harnesses, isolate });
}

export function agentSend(
  sessionDir: string | undefined,
  name: string,
  prompt: string,
): Promise<string> {
  return callHost(sessionDir, HOST_AGENT_SEND, { name, prompt });
}

export function agentStop(sessionDir: string | undefined, name: string): Promise<string> {
  return callHost(sessionDir, HOST_AGENT_STOP, { name });
}

export function agentClose(sessionDir: string | undefined, name: string): Promise<string> {
  return callHost(sessionDir, HOST_AGENT_CLOSE, { name });
}
