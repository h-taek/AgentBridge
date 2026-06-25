// Single source of truth for the AgentBridge injected-context delimiters.
//
// Both the OPEN and CLOSE tags carry a fixed, unguessable sentinel (`k="…"`) so the
// PTY display filter (ptyDisplayFilter) and the codex transcript reader match ONLY
// the real injected block — never an incidental mention of the tag name in the
// visible stream. Two failure modes this guards:
//   - B-005: a bare `<agentbridge-context>` typed in chat (the assistant explaining
//     this feature) used to make the filter blank the screen. The OPEN sentinel means
//     a bare mention no longer matches.
//   - premature close: the injected block embeds prior turns / IR / memory verbatim,
//     which may quote a bare `</agentbridge-context>`. Because the real OPEN has fired,
//     the filter is scanning for the end while INSIDE the block — so a bare close in
//     that embedded body would end the hidden region early and leak the rest. The CLOSE
//     sentinel makes the real end distinguishable from any quoted bare close. We do not
//     escape the body, so embedded content is never mutated. (A quote of the exact
//     sentineled close would still collide, but that only arises while developing this
//     very feature — not in normal use.)
//
// Producer (bin/agentbridge-memory.js), filter, and reader all import these, so the
// matching sites cannot drift. To change the sentinel, edit only this file.

export const CONTEXT_OPEN_TAG = '<agentbridge-context k="ab83f1d0">';
export const CONTEXT_CLOSE_TAG = '</agentbridge-context k="ab83f1d0">';

// Sentinel-agnostic name prefix. Matches the sentineled OPEN tag AND legacy plain
// `<agentbridge-context>` tags already baked into transcripts recorded before this
// change, so the reader keeps recognizing pre-change sessions (backward compatibility).
export const CONTEXT_TAG_NAME_PREFIX = '<agentbridge-context';

// Wrap an assembled inner body into the injected-context block. The producer
// (bin/agentbridge-memory.js) builds the body and calls this, so the open/close
// delimiters live in exactly one place.
export function wrapInjectedContext(body: string): string {
  return CONTEXT_OPEN_TAG + '\n' + body + '\n' + CONTEXT_CLOSE_TAG;
}
