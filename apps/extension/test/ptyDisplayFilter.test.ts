import { strict as assert } from 'assert';
import { PtyDisplayFilter } from '../src/core/ptyDisplayFilter';

describe('PtyDisplayFilter', () => {
  it('passes through plain data unchanged', () => {
    const f = new PtyDisplayFilter();
    assert.equal(f.filter('hello world'), 'hello world');
    f.dispose();
  });

  it('replaces an entire context block with the hidden marker', () => {
    const f = new PtyDisplayFilter();
    const out = f.filter('pre<agentbridge-context>secret stuff</agentbridge-context>post');
    assert.match(out, /^pre\[hook context hidden\]post$/);
    f.dispose();
  });

  it('preserves partial open-tag across chunk boundaries', () => {
    const f = new PtyDisplayFilter();
    // Split the open tag mid-stream.
    const a = f.filter('alpha<agentbridge-c');
    const b = f.filter('ontext>secret</agentbridge-context>beta');
    assert.equal(a, 'alpha');
    assert.match(b, /\[hook context hidden\]beta/);
    f.dispose();
  });

  it('clears partial-tag carry when subsequent chunk doesn\'t continue the prefix', () => {
    const f = new PtyDisplayFilter();
    f.filter('text<agentb');
    const out = f.filter('NOT a tag continuation');
    // Even though the first chunk had a partial-prefix, the second chunk shouldn't lose data.
    // The exact carry handling lets `<agentb` be emitted before the second chunk's content.
    assert.match(out, /NOT a tag continuation/);
    f.dispose();
  });

  it('hides block when close tag has ANSI escape interleaved (codex TUI redraw)', () => {
    const f = new PtyDisplayFilter();
    // codex TUI inserts SGR/cursor sequences between characters when redrawing
    // the developer-message block. Naive indexOf misses the close tag entirely.
    const out = f.filter('pre<agentbridge-context>secret</\x1b[31magentbridge-context>post');
    assert.equal(out, 'pre[hook context hidden]post');
    f.dispose();
  });

  it('hides block when open tag has ANSI escape interleaved', () => {
    const f = new PtyDisplayFilter();
    const out = f.filter('pre<agentbridge\x1b[K-context>secret</agentbridge-context>post');
    assert.equal(out, 'pre[hook context hidden]post');
    f.dispose();
  });

  it('passes ANSI through unchanged when not inside a block', () => {
    const f = new PtyDisplayFilter();
    const out = f.filter('hello \x1b[31mworld\x1b[0m');
    assert.equal(out, 'hello \x1b[31mworld\x1b[0m');
    f.dispose();
  });

  it('flushes held ANSI when partial open match breaks', () => {
    const f = new PtyDisplayFilter();
    // Started matching <agent, then ANSI, then a non-matching char.
    // The ANSI + partial tag should be emitted as plain text, not lost.
    const out = f.filter('pre<agent\x1b[KXYZ');
    assert.equal(out, 'pre<agent\x1b[KXYZ');
    f.dispose();
  });

  it('carries incomplete ANSI across chunk boundary', () => {
    const f = new PtyDisplayFilter();
    const a = f.filter('hello \x1b[3');
    const b = f.filter('1mworld');
    assert.equal(a + b, 'hello \x1b[31mworld');
    f.dispose();
  });

  it('clears watchdog timer on dispose (no hanging timers)', () => {
    const f = new PtyDisplayFilter();
    f.filter('pre<agentbridge-context>opened-but-not-closed');
    // Dispose mid-block — should clear the watchdog. If it didn't, Node would hold the
    // event loop open and the mocha process would hang past test timeout.
    f.dispose();
    assert.ok(true);
  });
});
