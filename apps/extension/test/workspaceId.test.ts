import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deterministicWorkspaceId } from '@agentbridge/core';

const ID_RE = /^[^/\\\u0000]+-[0-9a-f]{4}$/;

describe('deterministicWorkspaceId', () => {
  it('같은 경로는 항상 같은 ID를 반환한다', () => {
    const a = deterministicWorkspaceId('/tmp/agentbridge-id-test');
    const b = deterministicWorkspaceId('/tmp/agentbridge-id-test');
    assert.equal(a, b);
  });

  it('다른 경로는 다른 ID를 반환한다', () => {
    const a = deterministicWorkspaceId('/tmp/agentbridge-id-test-1');
    const b = deterministicWorkspaceId('/tmp/agentbridge-id-test-2');
    assert.notEqual(a, b);
  });

  it('폴더 이름 + 다이제스트 네 자 형식이다', () => {
    const id = deterministicWorkspaceId('/tmp/agentbridge-id-test');
    assert.match(id, ID_RE);
    assert.equal(id.startsWith('agentbridge-id-test-'), true);
  });

  it('접미사는 항상 붙는다 (충돌할 때만이 아니라)', () => {
    const id = deterministicWorkspaceId('/tmp/agentbridge-solo-folder');
    assert.match(id.slice(-5), /^-[0-9a-f]{4}$/);
  });

  it('단일 경로 세그먼트다 (경로 탈출 방어)', () => {
    for (const p of ['/tmp/a/../b', '/tmp/.hidden', '/tmp/has space']) {
      const id = deterministicWorkspaceId(p);
      assert.equal(id.includes('/'), false);
      assert.equal(id.startsWith('.'), false);
    }
  });

  it('존재하지 않는 경로도 동작한다 (realpath 불가 시 절대경로 정규화 폴백)', () => {
    const id = deterministicWorkspaceId('/no/such/dir/agentbridge-test');
    assert.match(id, ID_RE);
  });

  it('심볼릭 링크와 원본 경로가 같은 ID를 반환한다 (realpath 정규화)', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'agentbridge-real-'));
    const target = join(base, 'target');
    const link = join(base, 'link');
    await fs.mkdir(target);
    await fs.symlink(target, link);
    try {
      assert.equal(deterministicWorkspaceId(link), deterministicWorkspaceId(target));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('같은 한글 경로의 NFC/NFD 인코딩이 같은 ID를 반환한다 (macOS 정규화 무관)', () => {
    const nfc = '/Users/x/사주라/프로젝트'.normalize('NFC');
    const nfd = '/Users/x/사주라/프로젝트'.normalize('NFD');
    // 존재하지 않는 경로 → realpath 폴백(resolve) 경로를 타므로 순수 정규화 동작 검증
    assert.equal(deterministicWorkspaceId(nfc), deterministicWorkspaceId(nfd));
  });
});
