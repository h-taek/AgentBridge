import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSkillInstaller, skillFilePath, renderSkillMarkdown } from '@agentbridge/core';

// 전역 스킬 설치 (0.5.0 3단계 W4) — 자리 셋은 실측으로 확정한 값이다(research 06 §3).
// 임시 홈에 대고 확인한다. 실제 홈의 전역 설정을 건드리지 않는다.
describe('skillInstaller — 전역 스킬 3종 (0.5.0 W4)', () => {
  let home: string;
  const execPath = '/Applications/Some IDE.app/Contents/MacOS/Electron';
  const cliPath = '/Users/x/agentbridge/bin/agentbridge.js';

  beforeEach(async () => {
    home = await fsp.mkdtemp(join(tmpdir(), 'ab-skill-'));
  });

  afterEach(async () => {
    if (home) await fsp.rm(home, { recursive: true, force: true });
  });

  function installer(logger?: { log: (m: string) => void; warn: (m: string) => void }) {
    return createSkillInstaller({ execPath, cliPath, homeDir: home, logger });
  }

  it('하니스별 자리가 실측과 같다', () => {
    assert.equal(skillFilePath('claude', home), join(home, '.claude', 'skills', 'agentbridge', 'SKILL.md'));
    assert.equal(skillFilePath('codex', home), join(home, '.agents', 'skills', 'agentbridge', 'SKILL.md'));
    assert.equal(skillFilePath('agy', home), join(home, '.gemini', 'config', 'skills', 'agentbridge', 'SKILL.md'));
  });

  it('세션 하나를 열면 그 하니스에만 깔린다', async () => {
    await installer().install('codex');
    await fsp.access(skillFilePath('codex', home));
    await assert.rejects(fsp.access(skillFilePath('claude', home)));
    await assert.rejects(fsp.access(skillFilePath('agy', home)));
  });

  it('본문에 런타임과 CLI 절대경로가 박히고 node로 시작하는 줄이 없다', async () => {
    const file = await installer().install('claude');
    const body = await fsp.readFile(file, 'utf8');
    assert.ok(body.includes(cliPath), 'CLI 절대경로가 있어야 한다');
    assert.ok(body.includes(execPath), '런타임 절대경로가 있어야 한다');
    for (const line of body.split('\n')) {
      assert.doesNotMatch(line.trim(), /^node\s/, `node로 시작하는 줄: ${line}`);
    }
  });

  it('사용자 명령인 uninstall은 싣지 않는다', () => {
    assert.doesNotMatch(renderSkillMarkdown({ execPath, cliPath }), /uninstall/);
  });

  it('내용이 같으면 다시 쓰지 않는다', async () => {
    const file = await installer().install('agy');
    const first = (await fsp.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await installer().install('agy');
    assert.equal((await fsp.stat(file)).mtimeMs, first);
  });

  it('경로가 바뀌면 다시 쓴다', async () => {
    const file = await installer().install('agy');
    await createSkillInstaller({
      execPath,
      cliPath: '/Users/x/moved/agentbridge.js',
      homeDir: home,
    }).install('agy');
    assert.match(await fsp.readFile(file, 'utf8'), /moved\/agentbridge\.js/);
  });

  it('공백이 든 경로는 셸에서 쓸 수 있게 감싼다', () => {
    const body = renderSkillMarkdown({ execPath, cliPath });
    assert.match(body, /'\/Applications\/Some IDE\.app\/Contents\/MacOS\/Electron'/);
  });
});
