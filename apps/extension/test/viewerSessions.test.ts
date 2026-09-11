import { strict as assert } from 'assert';
import { candidateSessions, docRelativePath } from '../src/views/viewerSessions';

const s = (o: Partial<Parameters<typeof candidateSessions>[0][number]>) => ({
  sessionId: 'a', name: 'claude', model: 'claude' as const, cwd: '/repo', alive: true, ...o,
});

describe('viewerSessions.candidateSessions', () => {
  it('죽은 세션을 뺀다', () => {
    const out = candidateSessions([s({ alive: false })], '/repo/docs/a.html');
    assert.equal(out.length, 0);
  });

  it('작업 디렉터리가 파일의 상위가 아니면 뺀다', () => {
    const out = candidateSessions([s({ cwd: '/other' })], '/repo/docs/a.html');
    assert.equal(out.length, 0);
  });

  it('작업 디렉터리가 같거나 상위면 남긴다', () => {
    assert.equal(candidateSessions([s({ cwd: '/repo' })], '/repo/a.html').length, 1);
    assert.equal(candidateSessions([s({ cwd: '/repo/docs' })], '/repo/docs/a.html').length, 1);
  });

  it('worktree 안의 파일에는 그 worktree 세션이 후보다', () => {
    const all = [s({ sessionId: 'main', cwd: '/repo' }), s({ sessionId: 'sub', cwd: '/ws/trees/x' })];
    const out = candidateSessions(all, '/ws/trees/x/docs/a.html');
    assert.deepEqual(out.map((v) => v.sessionId), ['sub']);
  });

  it('경로 접두사만 같은 이웃 폴더를 상위로 보지 않는다', () => {
    const out = candidateSessions([s({ cwd: '/repo-old' })], '/repo/a.html');
    assert.equal(out.length, 0);
  });
});

describe('viewerSessions.docRelativePath', () => {
  it('세션의 작업 디렉터리 기준으로 접는다', () => {
    assert.equal(docRelativePath('/repo', '/repo/docs/a.html'), 'docs/a.html');
  });
  it('상위가 아니면 절대 경로를 그대로 쓴다', () => {
    assert.equal(docRelativePath('/other', '/repo/a.html'), '/repo/a.html');
  });
});
