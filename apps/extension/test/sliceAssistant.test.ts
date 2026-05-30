import { strict as assert } from 'assert';
import { sliceAssistant } from '../src/core/turnRecorder/sliceAssistant';

describe('sliceAssistant', () => {
  it('returns empty body for empty input', () => {
    const r = sliceAssistant({ raw: '', model: 'claude' });
    assert.equal(r.assistantBody, '');
    assert.deepEqual(r.toolCalls, []);
  });

  it('strips ANSI control sequences', () => {
    const raw = '[32mhello[0m world';
    const r = sliceAssistant({ raw, model: 'claude' });
    assert.match(r.assistantBody, /hello/);
    assert.match(r.assistantBody, /world/);
    assert.ok(!r.assistantBody.includes(''));
  });

  it('drops alt-screen begin/end blocks', () => {
    const raw = 'before[?1049hINSIDE[?1049lafter';
    const r = sliceAssistant({ raw, model: 'claude' });
    assert.match(r.assistantBody, /before/);
    assert.match(r.assistantBody, /after/);
    assert.ok(!r.assistantBody.includes('INSIDE'));
  });

  it('extracts claude tool markers with ⏺ prefix', () => {
    const raw = '⏺ Read(/tmp/foo)\nsome output\n';
    const r = sliceAssistant({ raw, model: 'claude' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].tool, 'Read');
    assert.equal(r.toolCalls[0].arg, '/tmp/foo');
  });

  it('does not strip short capitalized single-word lines that appear in prose (M11 regression)', () => {
    // Chrome filter uses `^[A-Z][A-Za-z-]{2,19}…?\s*\d*$` which could false-positive on
    // legitimate single-word lines like "TypeScript" or "React" appearing alone.
    // This guard pins current behavior — if false-positive removes prose, this fails.
    const raw = 'Using TypeScript for the parser.\nReact handles the UI.\nDone.\n';
    const r = sliceAssistant({ raw, model: 'claude' });
    assert.match(r.assistantBody, /Using TypeScript for the parser/);
    assert.match(r.assistantBody, /React handles the UI/);
  });

  it('skips codex when no claude/agy markers (conservative)', () => {
    const raw = 'plain assistant response without markers\nmore text\n';
    const r = sliceAssistant({ raw, model: 'codex' });
    assert.deepEqual(r.toolCalls, []);
    assert.match(r.assistantBody, /plain assistant response/);
  });
});
