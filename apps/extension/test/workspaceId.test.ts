import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deterministicWorkspaceId } from '@agentbridge/core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  it('표준 UUID 형식이다 (기존 경로 탈출 방어 검증 통과)', () => {
    const id = deterministicWorkspaceId('/tmp/agentbridge-id-test');
    assert.match(id, UUID_RE);
  });

  it('UUID 버전 비트가 5다', () => {
    const id = deterministicWorkspaceId('/tmp/agentbridge-id-test');
    // xxxxxxxx-xxxx-5xxx-... 세 번째 그룹 첫 글자
    assert.equal(id.split('-')[2][0], '5');
  });

  it('존재하지 않는 경로도 동작한다 (realpath 불가 시 절대경로 정규화 폴백)', () => {
    const id = deterministicWorkspaceId('/no/such/dir/agentbridge-test');
    assert.match(id, UUID_RE);
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
