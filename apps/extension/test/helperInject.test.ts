import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeProfileDocs, getGlobalDir } from '@agentbridge/core';

describe('helper inject — 글로벌 메모리 검색 종단(§G3)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;

  before(async function () {
    this.timeout(30000); // esbuild 번들 빌드 여유
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-helper-'));
    userData = join(tmp, 'userdata');
    bundlePath = join(tmp, 'agentbridge-memory.js');

    // 실제 번들 스크립트로 self-contained 헬퍼 생성(번들 정합성까지 검증).
    // ts-node(CommonJS)는 await import(file://)를 require로 다운레벨해 .mjs를 못 부른다 → 자식 프로세스로 spawn.
    // 테스트 cwd = apps/extension → ../../ = repo root → scripts/bundle-helper.mjs
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });

    // 프로필에 검색 대상 문서 시드(globalDir = userData/global).
    const globalDir = getGlobalDir(userData);
    await writeProfileDocs(globalDir, 'default', {
      docs: [{
        category: 'conventions',
        slug: 'deploy-flow',
        title: 'Deployment workflow',
        summary: 'Use the release branch and tag before publishing to production.',
        body: 'Run the release script then tag.',
        indexEntries: ['deployment workflow'],
      }],
    });

    // workspace 디렉토리(IR/turns 없음 — 글로벌 주입만 격리 검증).
    await fsp.mkdir(join(userData, 'workspaces', 'ws-1'), { recursive: true });
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function run(stdin: string): any {
    const out = execFileSync(
      'node',
      [bundlePath, 'inject', '--agent', 'claude', '--workspace', 'ws-1', '--user-data', userData, '--event', 'UserPromptSubmit'],
      { input: stdin, encoding: 'utf8' },
    );
    return JSON.parse(out);
  }

  it('stdin 프롬프트와 매치되는 글로벌 문서를 주입한다', () => {
    const res = run(JSON.stringify({ prompt: 'how do I handle deployment to production?' }));
    const ctx = res.hookSpecificOutput.additionalContext as string;
    assert.match(ctx, /Global memory/);
    assert.match(ctx, /Deployment workflow/);
    assert.equal(res.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  });

  it('매치가 없으면 글로벌 섹션을 생략한다(IR/turns 주입은 불변)', () => {
    const res = run(JSON.stringify({ prompt: 'zzzzz totally unrelated quokka' }));
    const ctx = res.hookSpecificOutput.additionalContext as string;
    assert.doesNotMatch(ctx, /Global memory/);
  });
});
