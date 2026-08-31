import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installBinToCanonicalPath,
  getCanonicalBinPath,
} from '@agentbridge/core';

describe('hook helper 단일 설치', () => {
  let root: string;
  let bundleDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'agentbridge-helper-'));
    bundleDir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-bundle-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(bundleDir, { recursive: true, force: true });
  });

  async function writeBundledHelper(version: string): Promise<string> {
    const p = join(bundleDir, 'agentbridge-memory.js');
    await fs.writeFile(p, `// @agentbridge-helper-version ${version}\nconsole.log('helper ${version}')\n`, 'utf8');
    return p;
  }

  it('canonical 경로는 <root>/bin/agentbridge-memory.js 이다', () => {
    assert.equal(getCanonicalBinPath(root, 'helper'), join(root, 'bin', 'agentbridge-memory.js'));
  });

  it('미설치 상태면 번들 helper를 설치한다', async () => {
    const bundled = await writeBundledHelper('0.2.0');
    const canonical = await installBinToCanonicalPath(bundled, root, 'helper');
    const content = await fs.readFile(canonical, 'utf8');
    assert.match(content, /helper 0\.2\.0/);
  });

  it('설치본보다 번들이 새 버전이면 덮어쓴다', async () => {
    const oldBundled = await writeBundledHelper('0.1.0');
    await installBinToCanonicalPath(oldBundled, root, 'helper');
    const newBundled = await writeBundledHelper('0.2.0');
    const canonical = await installBinToCanonicalPath(newBundled, root, 'helper');
    const content = await fs.readFile(canonical, 'utf8');
    assert.match(content, /helper 0\.2\.0/);
  });

  it('설치본이 번들보다 새 버전이면 덮어쓰지 않는다 (다운그레이드 방지)', async () => {
    const newBundled = await writeBundledHelper('0.3.0');
    await installBinToCanonicalPath(newBundled, root, 'helper');
    const oldBundled = await writeBundledHelper('0.2.0');
    const canonical = await installBinToCanonicalPath(oldBundled, root, 'helper');
    const content = await fs.readFile(canonical, 'utf8');
    assert.match(content, /helper 0\.3\.0/);
  });

  it('버전이 같아도 내용이 다르면 덮어쓴다 (마커 안 올린 헬퍼 수정 자가 치유)', async () => {
    const first = await writeBundledHelper('0.2.0');
    await installBinToCanonicalPath(first, root, 'helper');
    // 같은 버전으로 내용만 바꾼 번들 — 개발 중 헬퍼를 고치고 마커를 안 올린 상태다.
    const changed = join(bundleDir, 'agentbridge-memory.js');
    await fs.writeFile(changed, "// @agentbridge-helper-version 0.2.0\nconsole.log('helper changed')\n", 'utf8');
    const canonical = await installBinToCanonicalPath(changed, root, 'helper');
    const content = await fs.readFile(canonical, 'utf8');
    assert.match(content, /helper changed/);
  });

  it('버전과 내용이 모두 같으면 다시 쓰지 않는다', async () => {
    const bundled = await writeBundledHelper('0.2.0');
    const canonical = await installBinToCanonicalPath(bundled, root, 'helper');
    const before = (await fs.stat(canonical)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await installBinToCanonicalPath(bundled, root, 'helper');
    assert.equal((await fs.stat(canonical)).mtimeMs, before);
  });

  it('실제 번들 helper(packages/core/bin)에 버전 마커가 있다', async () => {
    const realHelper = join(__dirname, '..', '..', '..', 'packages', 'core', 'bin', 'agentbridge-memory.js');
    const content = await fs.readFile(realHelper, 'utf8');
    assert.match(content, /@agentbridge-helper-version \d+\.\d+\.\d+/);
  });
});
