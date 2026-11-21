// 스킬 본문의 0.9.0 문구 (spec/02 `session new`, spec/03 §3 서브의 서브 막기).
import { strict as assert } from 'assert';
import { renderSkillMarkdown, SKILL_VERSION } from '@agentbridge/core';

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
