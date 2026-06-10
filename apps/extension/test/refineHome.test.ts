import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureRefineHome } from '@agentbridge/core';

const rootDir = '/tmp/abtest-root';

describe('refineHome', () => {
  it('returns empty env on non-darwin (현행 경로 유지)', () => {
    const r = ensureRefineHome('agy', { platform: 'win32', rootDir: '/tmp/never' });
    assert.deepEqual(r.env, {});
  });

  it('darwin + agy → HOME set to box', () => {
    const r = ensureRefineHome('agy', { platform: 'darwin', rootDir });
    assert.deepEqual(r.env, { HOME: join(rootDir, 'agy') });
  });

  it('darwin + codex → CODEX_HOME set to box', () => {
    const r = ensureRefineHome('codex', { platform: 'darwin', rootDir });
    assert.deepEqual(r.env, { CODEX_HOME: join(rootDir, 'codex') });
  });

  it('darwin + claude → empty env (격리 미지원)', () => {
    const r = ensureRefineHome('claude', { platform: 'darwin', rootDir });
    assert.deepEqual(r.env, {});
  });

  it('agy: HOME env + Keychains/Caches/bin 심링크 생성', async () => {
    const rootDir = await fs.mkdtemp(join(tmpdir(), 'abtest-'));
    const realHome = '/fake/home';
    const r = ensureRefineHome('agy', { platform: 'darwin', rootDir, realHome });
    const box = join(rootDir, 'agy');
    try {
      assert.equal(r.env.HOME, box);
      assert.equal(await fs.readlink(join(box, 'Library/Keychains')), join(realHome, 'Library/Keychains'));
      assert.equal(await fs.readlink(join(box, 'Library/Caches')), join(realHome, 'Library/Caches'));
      assert.equal(await fs.readlink(join(box, '.gemini/antigravity-cli/bin')), join(realHome, '.gemini/antigravity-cli/bin'));
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('codex: CODEX_HOME env + auth.json 심링크 + 플러그인 없는 최소 config', async () => {
    const rootDir = await fs.mkdtemp(join(tmpdir(), 'abtest-'));
    try {
      const r = ensureRefineHome('codex', { platform: 'darwin', rootDir, realHome: '/fake/home' });
      const box = join(rootDir, 'codex');
      assert.equal(r.env.CODEX_HOME, box);
      assert.equal(await fs.readlink(join(box, 'auth.json')), '/fake/home/.codex/auth.json');
      const cfg = await fs.readFile(join(box, 'config.toml'), 'utf8');
      assert.equal(cfg, '[features]\nsuppress_unstable_features_warning = true\n', 'config에 플러그인 항목 없어야(69M clone 방지)');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('버전 토큰 불일치 시 박스 폐기 후 재부팅', async () => {
    const rootDir = await fs.mkdtemp(join(tmpdir(), 'abtest-'));
    try {
      const binA = join(rootDir, 'binA'); await fs.writeFile(binA, 'v1');
      ensureRefineHome('agy', { platform: 'darwin', rootDir, realHome: '/fake/home', binPath: binA });
      const box = join(rootDir, 'agy');
      await fs.writeFile(join(box, 'marker'), 'stale');               // 박스 안 잔재
      const binB = join(rootDir, 'binB'); await fs.writeFile(binB, 'v2-different-size');
      ensureRefineHome('agy', { platform: 'darwin', rootDir, realHome: '/fake/home', binPath: binB });
      // 버전 바뀌면 박스 통째 폐기 → marker 사라지고 심링크 재생성
      await assert.rejects(fs.lstat(join(box, 'marker')), 'marker는 재부팅으로 사라져야');
      assert.ok(await fs.readlink(join(box, 'Library/Keychains')), '재부팅 후 심링크 재생성');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('버전 토큰 동일 시 박스 재사용(잔재 보존)', async () => {
    const rootDir = await fs.mkdtemp(join(tmpdir(), 'abtest-'));
    try {
      const bin = join(rootDir, 'bin'); await fs.writeFile(bin, 'v1');
      ensureRefineHome('agy', { platform: 'darwin', rootDir, realHome: '/fake/home', binPath: bin });
      const box = join(rootDir, 'agy');
      await fs.writeFile(join(box, 'marker'), 'keep');
      ensureRefineHome('agy', { platform: 'darwin', rootDir, realHome: '/fake/home', binPath: bin });
      assert.equal(await fs.readFile(join(box, 'marker'), 'utf8'), 'keep', '동일 버전이면 잔재 보존');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
