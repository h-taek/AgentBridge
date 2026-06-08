// transcript 파일 경로 해석 — claude enc-cwd(실측 디렉토리명) + agy 후보 + codex glob.
import { strict as assert } from 'assert';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { encodeClaudeProjectDir, resolveTranscriptPath } from '@agentbridge/core';

describe('resolveTranscriptPath', () => {
  it('encodeClaudeProjectDir: 비영숫자를 전부 -로 (실측 디렉토리명과 일치)', () => {
    const cwd = '/Users/imhyeongtaeg/Library/Mobile Documents/com~apple~CloudDocs/02_Personal/02_Project/01_AgentBridge';
    assert.equal(
      encodeClaudeProjectDir(cwd),
      '-Users-imhyeongtaeg-Library-Mobile-Documents-com-apple-CloudDocs-02-Personal-02-Project-01-AgentBridge',
    );
  });

  it('claude: ~/.claude/projects/<enc-cwd>/<id>.jsonl', async () => {
    const p = await resolveTranscriptPath('claude', 'abc-123', '/x/y');
    assert.equal(p, join(homedir(), '.claude', 'projects', '-x-y', 'abc-123.jsonl'));
  });

  it('agy: brain/<id>/.system_generated/logs/transcript.jsonl', async () => {
    const p = await resolveTranscriptPath('agy', 'conv-uuid', '/x');
    assert.equal(
      p,
      join(homedir(), '.gemini', 'antigravity-cli', 'brain', 'conv-uuid', '.system_generated', 'logs', 'transcript.jsonl'),
    );
  });

  it('codex: 실제 rollout 파일을 modelSessionId로 찾는다 (있을 때만)', async function () {
    const id = '019e9dd4-6d39-79a3-bbae-aaf5ad82db8f';
    const expected = join(homedir(), '.codex/sessions/2026/06/07', `rollout-2026-06-07T01-46-45-${id}.jsonl`);
    if (!existsSync(expected)) this.skip();
    const p = await resolveTranscriptPath('codex', id, '/x');
    assert.equal(p, expected);
  });
});
