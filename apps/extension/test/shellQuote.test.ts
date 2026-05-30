import { strict as assert } from 'assert';
import { quoteArg, quoteCommandLine } from '../src/shared/shellQuote';

describe('shellQuote', () => {
  it('returns the bare arg for safe chars', () => {
    assert.equal(quoteArg('foo'), 'foo');
    assert.equal(quoteArg('/usr/bin/agy'), '/usr/bin/agy');
    assert.equal(quoteArg('node'), 'node');
  });

  it('wraps empty string', () => {
    assert.equal(quoteArg(''), "''");
  });

  it('wraps strings with spaces', () => {
    assert.equal(quoteArg('hello world'), "'hello world'");
  });

  it('escapes embedded single quotes (regression for chatPanel:198)', () => {
    // The bug we're guarding: `'${a}'` wrapping breaks on `O'Brien` because the literal
    // ' inside terminates the wrapping ' and the shell sees a syntax error.
    const escaped = quoteArg("O'Brien");
    // POSIX safe escape: close quote, escaped quote, reopen — '"'"'
    assert.equal(escaped, "'O'\"'\"'Brien'");
  });

  it('quoteCommandLine joins quoted args', () => {
    const line = quoteCommandLine(['/bin/echo', 'hello world', "it's me"]);
    assert.equal(line, "/bin/echo 'hello world' 'it'\"'\"'s me'");
  });
});
