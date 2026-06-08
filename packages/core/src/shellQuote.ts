// POSIX shell single-quote escape. Safe for paths/args passed via `/bin/sh -c` or `/bin/zsh -lc`.
// Safe chars stay bare; everything else gets wrapped in '…' with embedded ' rewritten as '"'"'.
//
// Note: 잘못된 `'\''` 패턴은 POSIX 호환 단일 따옴표 escape가 아니다.
// `'"'"'` 가 정답: close-quote, escaped-quote in double-quotes, re-open-quote.

export function quoteArg(s: string): string {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

export function quoteCommandLine(parts: string[]): string {
  return parts.map(quoteArg).join(' ');
}
