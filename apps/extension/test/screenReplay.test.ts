import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireOwnership, updateOwnerSize, releaseOwnership, replayLogPath } from '@agentbridge/core';
import { renderScreen } from '@agentbridge/core/dist/screenReplay';

describe('screenReplay', () => {
  const dirs: string[] = [];

  async function makeSessionDir(): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-screen-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('replayLogPath는 세션 폴더 아래 replay.log 경로를 반환한다', () => {
    assert.equal(replayLogPath('/tmp/ws/sessions/sub1'), join('/tmp/ws/sessions/sub1', 'replay.log'));
  });

  it('픽스처 replay.log를 재생해 제어 문자를 벗기고 줄 끝 공백·아래쪽 빈 줄을 뺀다', async () => {
    const fixtureDir = join(__dirname, 'fixtures', 'screenReplay');
    const res = await renderScreen(fixtureDir);

    assert.deepEqual(res, {
      cols: 120,
      rows: 30,
      text: [
        '● Subagent status',
        '────────────────────',
        'Total: 105 lines',
        '',
        '? for shortcuts',
      ].join('\n'),
    });
  });

  it('replay.log가 없거나 0바이트면 null을 반환한다', async () => {
    const missingDir = await makeSessionDir();
    assert.equal(await renderScreen(missingDir), null);

    const emptyDir = await makeSessionDir();
    await fs.writeFile(replayLogPath(emptyDir), '', 'utf8');
    assert.equal(await renderScreen(emptyDir), null);
  });

  it('owner.json이 있으면 그 cols·rows를 쓰고, 없으면 120×30을 쓴다', async () => {
    const dir = await makeSessionDir();
    const longLine = 'A'.repeat(30);
    await fs.writeFile(replayLogPath(dir), longLine, 'utf8');

    const withoutOwner = await renderScreen(dir);
    assert.deepEqual(withoutOwner, {
      cols: 120,
      rows: 30,
      text: longLine,
    });

    await acquireOwnership(dir, { app: 'extension', cols: 20, rows: 4 });
    const withOwner = await renderScreen(dir);
    assert.deepEqual(withOwner, {
      cols: 20,
      rows: 4,
      text: `${'A'.repeat(20)}\n${'A'.repeat(10)}`,
    });
  });

  it('탭이 닫혀 owner.json이 지워져도 replay-size.json의 마지막 크기로 재생한다', async () => {
    const dir = await makeSessionDir();
    await fs.writeFile(replayLogPath(dir), 'A'.repeat(30), 'utf8');

    await acquireOwnership(dir, { app: 'extension', cols: 20, rows: 4 });
    await updateOwnerSize(dir, 15, 5);
    await releaseOwnership(dir);

    assert.deepEqual(await renderScreen(dir), {
      cols: 15,
      rows: 5,
      text: `${'A'.repeat(15)}\n${'A'.repeat(15)}`,
    });
  });

  it('앞부분 상태가 끝 화면을 정하므로 꼬리만 재생하면 결과가 달라진다', async () => {
    const fullDir = await makeSessionDir();
    const tailDir = await makeSessionDir();

    // 앞부분에서 대체 화면 진입 + 헤더 출력 + 커서 저장(DECSC)까지 해 두고,
    // 꼬리에서는 저장된 커서 복원(DECRC) 뒤 마지막 줄만 덮어쓴다.
    const head = '\x1b[?1049h\x1b[1;1H=== HEADER ===\x1b[3;1H\x1b7waiting...';
    const tail = '\x1b8\x1b[KDone!';

    await fs.writeFile(replayLogPath(fullDir), head + tail, 'utf8');
    await fs.writeFile(replayLogPath(tailDir), tail, 'utf8');

    const full = await renderScreen(fullDir);
    const tailOnly = await renderScreen(tailDir);

    assert.equal(full?.text, '=== HEADER ===\n\nDone!');
    assert.notEqual(tailOnly?.text, full?.text);
    assert.equal(tailOnly?.text, 'Done!');
  });

  it('한글 폭과 Unicode 11 글자 폭에 맞춰 줄을 바꾼다', async () => {
    const dir = await makeSessionDir();
    await acquireOwnership(dir, { app: 'extension', cols: 10, rows: 5 });
    // '가나다라마' = 10칸(줄 1 끝) + '바' = 줄 2,
    // '🔍'(Unicode 11 폭 2) + '가나다라'(폭 8) = 10칸(줄 3 끝) + 'X' = 줄 4.
    await fs.writeFile(replayLogPath(dir), '가나다라마바\r\n🔍가나다라X', 'utf8');

    const res = await renderScreen(dir);
    assert.deepEqual(res, {
      cols: 10,
      rows: 5,
      text: ['가나다라마', '바', '🔍가나다라', 'X'].join('\n'),
    });
  });
});
