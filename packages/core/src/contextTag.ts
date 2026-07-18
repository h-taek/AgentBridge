// Single source of truth for the AgentBridge injected-context delimiters.
//
// The injected block is wrapped in a plain `<agentbridge-context>` … `</agentbridge-context>`
// pair. The codex transcript reader classifies the block as non-user input by matching the
// name prefix (CONTEXT_TAG_NAME_PREFIX) with startsWith — it never parses the closing tag and
// is agnostic to any tag attributes, so the delimiters stay attribute-free. (The former
// `k="…"` sentinel existed only for the PTY display filter, which has been removed.)
//
// Preview suppression: codex renders a completed UserPromptSubmit hook's additionalContext as
// a collapsed "hook context" cell showing the first 2 body lines, then "… +N lines"
// (codex-rs/tui HOOK_CONTEXT_MAX_DISPLAY_ROWS = 3; blank lines are rendered literally and
// count toward that budget). wrapInjectedContext therefore puts the open tag on line 1 and a
// blank line on line 2, so the preview reveals only the bare tag name — the real context body
// starts on line 3 and stays collapsed. The model still receives the whole block verbatim
// (the blank line is inert).
//
// Producer (bin/agentbridge-memory.js) and reader both import these, so the matching sites
// cannot drift. Edit only this file.

export const CONTEXT_OPEN_TAG = '<agentbridge-context>';
export const CONTEXT_CLOSE_TAG = '</agentbridge-context>';

// Sentinel-agnostic name prefix. Matches the OPEN tag regardless of attributes AND legacy
// `<agentbridge-context k="…">` tags baked into transcripts recorded before this change, so
// the reader keeps recognizing pre-change sessions (backward compatibility).
export const CONTEXT_TAG_NAME_PREFIX = '<agentbridge-context';

// Wrap an assembled inner body into the injected-context block. The producer
// (bin/agentbridge-memory.js) builds the body and calls this, so the open/close delimiters —
// and the preview-suppressing blank line after the open tag — live in exactly one place.
export function wrapInjectedContext(body: string): string {
  return CONTEXT_OPEN_TAG + '\n\n' + body + '\n' + CONTEXT_CLOSE_TAG;
}
