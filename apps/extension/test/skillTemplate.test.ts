// 스킬 본문의 0.9.0 문구 (spec/02 `session new`, spec/03 §3 서브의 서브 막기).
import { strict as assert } from 'assert';
import { renderSkillMarkdown, renderCleanupSkillMarkdown, SKILL_VERSION } from '@agentbridge/core';

describe('skill template — session new와 서브의 서브 금지 (0.9.0)', () => {
  const md = renderSkillMarkdown({ execPath: '/usr/bin/node', cliPath: '/root/bin/agentbridge.js' });

  it('Commands 목록에 session new가 있다', () => {
    assert.ok(md.includes('session new [--harness claude|codex|agy]'));
  });

  it('Subagents 절이 서브는 건너뛰라고 한다', () => {
    assert.ok(md.includes('If the hook says you are a subagent, skip this section'));
    // 제목 바로 다음 문단이다.
    assert.match(
      md,
      /## Subagents\n\nIf the hook says you are a subagent, skip this section — a subagent does not\nstart sessions\.\n/,
    );
  });

  it('Subagents 절 끝에 session new 단락이 있다', () => {
    const at = md.indexOf('`session new` is not a subagent.');
    assert.ok(at > 0);
    // 그 절 안이다 — 다음 소절 제목보다 앞이다.
    assert.ok(at < md.indexOf('### Evaluating the model a sub ran on'));
    assert.ok(at > md.indexOf('## Subagents'));
  });

  it('버전 표지가 0.6.3이다', () => {
    assert.equal(SKILL_VERSION, '0.6.3');
    assert.ok(md.includes('<!-- @agentbridge-skill-version 0.6.3 -->'));
  });
});

// 0.9.0 spec/06 — 서브 지시문은 파일 경로가 아니라 프롬프트로 넘긴다.
describe('skill template — 서브 지시문 전달 (0.9.0)', () => {
  const md = renderSkillMarkdown({ execPath: '/usr/bin/node', cliPath: '/root/bin/agentbridge.js' });

  it('Subagents 절이 지시문을 --prompt에 다 넣으라고 한다', () => {
    const at = md.indexOf('Put the whole instruction in `--prompt`');
    assert.ok(at > md.indexOf('## Subagents'));
    assert.ok(at < md.indexOf('### Evaluating the model a sub ran on'));
    assert.ok(md.includes('Do not write it\nto a file and hand the sub the path.'));
  });
});

// 0.10.0 spec/01 §5 — 정리 스킬은 일반 지식부터 지우고, 실수 지적은 남길 이유가 되지 않는다.
describe('cleanup skill — 일반 지식은 맨 먼저 지운다 (0.10.0)', () => {
  const md = renderCleanupSkillMarkdown({ execPath: '/usr/bin/node', cliPath: '/root/bin/agentbridge.js' });

  it('삭제 기준이 일반 지식으로 시작하고 실수 지적은 남기지 않는다', () => {
    const del = md.indexOf('- **Delete** — first, the entry is general knowledge');
    const merge = md.indexOf('- **Merge**');
    assert.ok(del > 0 && merge > del);
    const test = md.indexOf('if the entry were deleted, would a capable model work any differently?');
    const past = md.indexOf('Delete also when the entry only records a\n  past state');
    assert.ok(test > del && past > test && past < merge);
    const slip = md.indexOf('A\n  correction of a slip is not that.');
    assert.ok(slip > past && slip < merge);
  });
});

// 0.10.0 spec/01 §4 — 기록 절차 스킬은 일반 지식을 맨 먼저 버린다.
describe('skill — 기록할 때 일반 지식을 먼저 버린다 (0.10.0)', () => {
  const md = renderSkillMarkdown({ execPath: '/usr/bin/node', cliPath: '/root/bin/agentbridge.js' });

  it('실수 지적은 규칙이 아니고, 버릴 것의 맨 앞이 일반 지식이다', () => {
    assert.ok(md.includes('A correction of a slip\n   against what a capable model already does is still not a rule'));
    assert.ok(md.includes('Throw away, first, anything that fails step 2 of the bar'));
  });

  // 0.10.0 spec/02 §2 — 훅에서 뺀 것은 스킬이 정본이다.
  it('문턱 전문, turns·context 설명, status가 스킬에 있다', () => {
    const rec = md.indexOf('## Recording something');
    const bar = md.indexOf('### The bar', rec);
    const steps = md.indexOf('### Steps', bar);
    assert.ok(rec > 0 && bar > rec && steps > bar);
    const body = md.slice(bar, steps);
    assert.ok(body.includes('1. Did the user set this for the future?'));
    assert.ok(body.includes('2. Would a capable model know or do this without being told?'));
    assert.ok(body.includes('3. Will it still be true'));
    assert.ok(md.includes('### What `turns` and `context` hold'));
    assert.ok(md.includes('`turns` and `agent read` are not the same.'));
    assert.ok(md.includes('    status                        whether the wiring is alive'));
  });
});

