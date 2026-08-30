// 0.5.0 W2 — 세션 상태 판정(순수 로직·집계·디스크 리더 캐시).
// 판정 규칙 근거: docs/0.5.0/spec/01_orca_adoption.md B-2 "상태 표시는 활동이지 판정이 아니다".
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeSessionActivity,
  aggregateActivity,
  readSessionActivityInputs,
  SILENCE_MS,
  resolveTurnStartFile,
  resolveTurnSignalFile,
  readTurnStart,
  readTurnSignal,
  type SessionActivityIo,
} from '@agentbridge/core';

describe('세션 상태 판정 — 순수 로직', () => {
  const NOW = 1_000_000;

  it('시작만 있으면 진행 중이다', () => {
    assert.equal(computeSessionActivity({ startAt: NOW - 1000 }, NOW), 'running');
  });

  it('종료만 있고 열람보다 뒤면 완료다', () => {
    assert.equal(computeSessionActivity({ endAt: NOW - 100, viewedAt: NOW - 200 }, NOW), 'done');
  });

  it('종료만 있고 열람보다 앞이면 idle이다', () => {
    assert.equal(computeSessionActivity({ endAt: NOW - 200, viewedAt: NOW - 100 }, NOW), 'idle');
  });

  it('시작·종료 둘 다 있고 정상 완료(종료가 열람보다 뒤)면 완료다', () => {
    assert.equal(
      computeSessionActivity({ startAt: NOW - 2000, endAt: NOW - 1000, viewedAt: NOW - 1500 }, NOW),
      'done',
    );
  });

  it('둘 다 없으면 idle이다', () => {
    assert.equal(computeSessionActivity({}, NOW), 'idle');
  });

  it('시작과 종료가 같은 ms면 도는 중이 아니다(종료 시각이 시작 시각 "이상")', () => {
    assert.equal(
      computeSessionActivity({ startAt: NOW - 500, endAt: NOW - 500, viewedAt: NOW - 600 }, NOW),
      'done',
    );
  });

  it('아직 한 번도 안 연 세션은 종료가 있으면 완료다(열람 시각 없음)', () => {
    assert.equal(computeSessionActivity({ endAt: NOW - 100 }, NOW), 'done');
  });

  it('정적 임계 경계 — 딱 SILENCE_MS 지나면 모름', () => {
    assert.equal(
      computeSessionActivity({ startAt: NOW - 10_000, lastOutputAt: NOW - SILENCE_MS }, NOW),
      'unknown',
    );
  });

  it('정적 임계 경계 — SILENCE_MS 1ms 전이면 진행 중', () => {
    assert.equal(
      computeSessionActivity({ startAt: NOW - 10_000, lastOutputAt: NOW - (SILENCE_MS - 1) }, NOW),
      'running',
    );
  });

  it('마지막 출력 시각이 없으면 시작 시각을 대신 쓴다', () => {
    assert.equal(computeSessionActivity({ startAt: NOW - SILENCE_MS - 1 }, NOW), 'unknown');
    assert.equal(computeSessionActivity({ startAt: NOW - (SILENCE_MS - 1) }, NOW), 'running');
  });
});

describe('세션 상태 판정 — 집계', () => {
  it('우선순위는 unknown > running > done > idle', () => {
    assert.equal(aggregateActivity('idle', ['done', 'running', 'unknown']), 'unknown');
    assert.equal(aggregateActivity('running', ['done']), 'running');
    assert.equal(aggregateActivity('idle', ['done']), 'done');
    assert.equal(aggregateActivity('idle', []), 'idle');
  });

  it('자식에 모름이 있으면 부모가 진행 중이어도 모름이다', () => {
    assert.equal(aggregateActivity('running', ['done', 'unknown']), 'unknown');
  });

  it('안 본 완료만 있으면 완료다', () => {
    assert.equal(aggregateActivity('idle', ['done', 'idle']), 'done');
  });
});

describe('세션 상태 판정 — 디스크 리더', () => {
  const SID = 'sess-status-1';
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'ab-sessionstatus-'));
    await fs.mkdir(join(ws, 'sessions', SID), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('세 파일이 있으면 셋 다 읽는다', async () => {
    await fs.writeFile(
      resolveTurnStartFile(ws, SID),
      JSON.stringify({ agent: 'claude', event: 'UserPromptSubmit', sessionId: SID, at: 100 }),
    );
    await fs.writeFile(
      resolveTurnSignalFile(ws, SID),
      JSON.stringify({
        agent: 'claude',
        event: 'Stop',
        sessionId: SID,
        transcriptPath: '/t',
        complete: true,
        at: 50,
      }),
    );
    await fs.writeFile(join(ws, 'sessions', SID, 'replay.log'), 'output');

    const input = await readSessionActivityInputs(ws, SID);
    assert.equal(input.startAt, 100);
    assert.equal(input.endAt, 50);
    assert.equal(typeof input.lastOutputAt, 'number');
  });

  it('세션 폴더가 없으면 값이 전부 비고, 그 결과가 idle이 된다', async () => {
    const input = await readSessionActivityInputs(ws, 'no-such-session');
    assert.equal(input.startAt, undefined);
    assert.equal(input.endAt, undefined);
    assert.equal(input.lastOutputAt, undefined);
    assert.equal(computeSessionActivity(input, Date.now()), 'idle');
  });

  it('mtime이 그대로면 turn-start·turn-signal을 다시 읽지 않는다', async () => {
    const startFile = resolveTurnStartFile(ws, SID);
    await fs.writeFile(
      startFile,
      JSON.stringify({ agent: 'claude', event: 'UserPromptSubmit', sessionId: SID, at: 100 }),
    );
    await fs.writeFile(
      resolveTurnSignalFile(ws, SID),
      JSON.stringify({
        agent: 'claude',
        event: 'Stop',
        sessionId: SID,
        transcriptPath: '/t',
        complete: true,
        at: 50,
      }),
    );
    await fs.writeFile(join(ws, 'sessions', SID, 'replay.log'), 'x');

    let startReads = 0;
    let signalReads = 0;
    const io: SessionActivityIo = {
      stat: (p) => fs.stat(p),
      readTurnStart: async (p) => {
        startReads++;
        return readTurnStart(p);
      },
      readTurnSignal: async (p) => {
        signalReads++;
        return readTurnSignal(p);
      },
    };

    await readSessionActivityInputs(ws, SID, io);
    await readSessionActivityInputs(ws, SID, io);
    assert.equal(startReads, 1, 'mtime이 그대로면 turn-start.json을 다시 읽지 않는다');
    assert.equal(signalReads, 1, 'mtime이 그대로면 turn-signal.json을 다시 읽지 않는다');

    // 내용을 바꾸고 mtime을 미래로 밀어 재읽기를 유도한다.
    const future = new Date(Date.now() + 5000);
    await fs.writeFile(
      startFile,
      JSON.stringify({ agent: 'claude', event: 'UserPromptSubmit', sessionId: SID, at: 200 }),
    );
    await fs.utimes(startFile, future, future);

    const third = await readSessionActivityInputs(ws, SID, io);
    assert.equal(startReads, 2, 'mtime이 바뀌면 다시 읽는다');
    assert.equal(third.startAt, 200);
  });
});
