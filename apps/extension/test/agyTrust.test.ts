// 0.5.0 3단계 — agy 신뢰 폴더 선점. 근거: docs/0.5.0/spec/01_orca_adoption.md B-8,
// docs/0.5.0/research/02_worktree_env.md §2.3.
import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  resolveAgyTrustFile,
  trustWorkspace,
} from '@agentbridge/core';

describe('agyTrust — agy 신뢰 폴더 선점', () => {
  let home: string;

  beforeEach(async () => {
    // 실제 사용자 홈(~/.gemini)을 건드리면 안 되므로 매번 가짜 홈을 새로 만든다.
    home = await fsp.mkdtemp(join(tmpdir(), 'ab-agytrust-'));
  });

  afterEach(async () => {
    if (home) await fsp.rm(home, { recursive: true, force: true });
  });

  function trustFilePath(): string {
    return resolveAgyTrustFile(home);
  }

  async function readSettings(): Promise<Record<string, unknown>> {
    const raw = await fsp.readFile(trustFilePath(), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it('resolveAgyTrustFile — 실측된 경로를 낸다', () => {
    assert.equal(
      resolveAgyTrustFile(home),
      join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    );
  });

  it('파일이 없을 때 — 만들어지고 경로가 들어간다', async () => {
    const target = join(home, 'ws', 'MyProject-worktree');
    await trustWorkspace(target, home);

    const settings = await readSettings();
    assert.deepEqual(settings.trustedWorkspaces, [target]);
  });

  it('이미 있는 설정의 다른 키가 보존된다', async () => {
    const filePath = trustFilePath();
    await fsp.mkdir(dirname(filePath), { recursive: true });
    await fsp.writeFile(
      filePath,
      JSON.stringify({
        someOtherSetting: true,
        nested: { a: 1, b: [1, 2, 3] },
        trustedWorkspaces: ['/already/trusted'],
      }),
      'utf8',
    );

    const target = join(home, 'ws', 'NewFolder');
    await trustWorkspace(target, home);

    const settings = await readSettings();
    assert.equal(settings.someOtherSetting, true);
    assert.deepEqual(settings.nested, { a: 1, b: [1, 2, 3] });
    assert.deepEqual(settings.trustedWorkspaces, ['/already/trusted', target]);
  });

  it('이미 들어 있는 경로를 다시 넣어도 중복이 안 생긴다', async () => {
    const target = join(home, 'ws', 'RepeatFolder');
    await trustWorkspace(target, home);
    await trustWorkspace(target, home);

    const settings = await readSettings();
    assert.deepEqual(settings.trustedWorkspaces, [target]);
  });

  it('기존 trustedWorkspaces 항목들이 보존된다', async () => {
    const filePath = trustFilePath();
    await fsp.mkdir(dirname(filePath), { recursive: true });
    await fsp.writeFile(
      filePath,
      JSON.stringify({ trustedWorkspaces: ['/a', '/b', '/c'] }),
      'utf8',
    );

    const target = join(home, 'ws', 'd');
    await trustWorkspace(target, home);

    const settings = await readSettings();
    assert.deepEqual(settings.trustedWorkspaces, ['/a', '/b', '/c', target]);
  });

  it('대소문자가 그대로 들어간다', async () => {
    const target = join(home, 'Ws', 'MixedCase-Folder');
    await trustWorkspace(target, home);

    const settings = await readSettings();
    assert.deepEqual(settings.trustedWorkspaces, [target]);
    // 소문자로 내려서는 안 된다(실측: agy가 소문자 경로를 신뢰로 인식하지 않음).
    assert.notEqual((settings.trustedWorkspaces as string[])[0], target.toLowerCase());
  });

  it('깨진 JSON이면 던지고 파일 내용이 그대로 남는다', async () => {
    const filePath = trustFilePath();
    await fsp.mkdir(dirname(filePath), { recursive: true });
    const broken = '{ this is not valid json';
    await fsp.writeFile(filePath, broken, 'utf8');

    await assert.rejects(() => trustWorkspace(join(home, 'ws', 'x'), home));

    const stillBroken = await fsp.readFile(filePath, 'utf8');
    assert.equal(stillBroken, broken);
  });
});
