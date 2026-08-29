// 0.5.0 B-1 — 첨부는 사용자 프로젝트가 아니라 우리 워크스페이스 데이터 폴더에 저장한다.
import { strict as assert } from 'assert';
import { promises as fs, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as workspaceStore from '../src/core/workspaceStore';
import {
  attachmentPathFor,
  writeAttachment,
  cleanupSessionAttachments,
  cleanupStaleAttachments,
  cleanupLegacyProjectFolder,
} from '../src/core/attachmentStore';
import { initCoreForTest } from './helpers';

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('attachmentStore', () => {
  let storagePath: string;
  let proj: string;
  let wid: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'ab-attach-store-'));
    proj = await fs.mkdtemp(join(tmpdir(), 'ab-attach-proj-'));
    initCoreForTest(storagePath);
    wid = workspaceStore.getOrCreateWorkspaceId(proj);
  });

  afterEach(async () => {
    for (const d of [storagePath, proj]) await fs.rm(d, { recursive: true, force: true });
  });

  it('저장 자리는 워크스페이스 데이터 폴더 아래다', () => {
    const p = attachmentPathFor(wid, SID, 'shot.png');
    assert.equal(p, join(workspaceStore.getWorkspacePath(wid), 'attachments', SID, 'shot.png'));
  });

  it('첨부를 써도 프로젝트 폴더에 아무것도 안 생긴다', async () => {
    const before = await fs.readdir(proj);
    await writeAttachment(attachmentPathFor(wid, SID, 'a.png'), Buffer.from('hi').toString('base64'));
    assert.deepEqual(await fs.readdir(proj), before, '프로젝트 폴더가 그대로여야 한다');
    // .gitignore도 만들지 않는다 — 더 이상 고칠 이유가 없다.
    assert.equal(existsSync(join(proj, '.gitignore')), false);
  });

  it('파일 이름의 경로 분리자는 잘라낸다 (traversal 방어)', () => {
    const p = attachmentPathFor(wid, `../../${SID}`, '../../../etc/passwd');
    assert.equal(p, join(workspaceStore.getWorkspacePath(wid), 'attachments', SID, 'passwd'));
  });

  it('세션 첨부 정리는 그 세션 폴더만 지운다', async () => {
    const other = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await writeAttachment(attachmentPathFor(wid, SID, 'a.png'), 'aGk=');
    await writeAttachment(attachmentPathFor(wid, other, 'b.png'), 'aGk=');
    await cleanupSessionAttachments(wid, SID);
    const root = join(workspaceStore.getWorkspacePath(wid), 'attachments');
    assert.deepEqual(await fs.readdir(root), [other]);
  });

  it('오래된 첨부만 지우고 최근 것은 남긴다', async () => {
    const oldFile = attachmentPathFor(wid, SID, 'old.png');
    const newFile = attachmentPathFor(wid, SID, 'new.png');
    await writeAttachment(oldFile, 'aGk=');
    await writeAttachment(newFile, 'aGk=');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(oldFile, twoHoursAgo, twoHoursAgo);

    await cleanupStaleAttachments(wid);
    assert.equal(existsSync(oldFile), false, '한 시간 넘은 것은 지운다');
    assert.equal(existsSync(newFile), true, '최근 것은 남긴다');
  });
});

describe('구버전 프로젝트 폴더 정리', () => {
  let storagePath: string;
  let proj: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'ab-attach-store2-'));
    proj = await fs.mkdtemp(join(tmpdir(), 'ab-attach-proj2-'));
    initCoreForTest(storagePath);
  });

  afterEach(async () => {
    for (const d of [storagePath, proj]) await fs.rm(d, { recursive: true, force: true });
  });

  it('.agentbridge/attachments를 지우고 빈 폴더도 없앤다', async () => {
    await fs.mkdir(join(proj, '.agentbridge', 'attachments', SID), { recursive: true });
    await fs.writeFile(join(proj, '.agentbridge', 'attachments', SID, 'x.png'), 'x');
    await fs.writeFile(join(proj, '.gitignore'), 'node_modules\n.agentbridge/\n', 'utf8');

    assert.equal(await cleanupLegacyProjectFolder(proj), true);
    assert.deepEqual(await fs.readdir(proj), ['.gitignore'], '우리 폴더가 남으면 안 된다');
  });

  it('.gitignore에 덧붙였던 줄은 남긴다', async () => {
    await fs.mkdir(join(proj, '.agentbridge', 'attachments'), { recursive: true });
    await fs.writeFile(join(proj, '.gitignore'), 'node_modules\n.agentbridge/\n', 'utf8');
    await cleanupLegacyProjectFolder(proj);
    assert.match(await fs.readFile(join(proj, '.gitignore'), 'utf8'), /\.agentbridge\//);
  });

  it('모르는 내용이 들어 있으면 폴더를 남긴다', async () => {
    await fs.mkdir(join(proj, '.agentbridge', 'attachments'), { recursive: true });
    await fs.writeFile(join(proj, '.agentbridge', 'something-else.json'), '{}');
    assert.equal(await cleanupLegacyProjectFolder(proj), false);
    assert.deepEqual(await fs.readdir(join(proj, '.agentbridge')), ['something-else.json']);
  });

  it('폴더가 없으면 아무것도 하지 않는다', async () => {
    assert.equal(await cleanupLegacyProjectFolder(proj), false);
    assert.deepEqual(await fs.readdir(proj), []);
  });
});
