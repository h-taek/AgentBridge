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

// 0.9.0 spec/05 §2 — 정리 스킬도 모델이 원래 하는 일반 원칙을 지운다.
describe('cleanup skill — 일반 원칙은 지운다 (0.9.0)', () => {
  const md = renderCleanupSkillMarkdown({ execPath: '/usr/bin/node', cliPath: '/root/bin/agentbridge.js' });

  it('삭제 기준에 일반 원칙과 남길 것이 있다', () => {
    const del = md.indexOf('- **Delete**');
    const merge = md.indexOf('- **Merge**');
    const at = md.indexOf('general good\n  practice a capable model follows without being told');
    assert.ok(del > 0 && at > del && at < merge);
    assert.ok(md.indexOf('What stays\n  is what a model would not know on its own') > at);
  });
});

