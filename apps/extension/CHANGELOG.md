# Changelog

This project follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 1.1.0 format and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<p align="center"><a href="CHANGELOG.ko.md">한국어</a></p>

## [Unreleased]

### Added

- New chat sessions are named automatically from your first message — the tab and sidebar now show a short title taken from what you first typed, instead of just the model name. You can still rename a session at any time, and auto-naming never overwrites a name you set.

### Changed

- Chat tabs now use each agent's official brand logo as the tab icon (replacing the old bitmap capture), and reopening a named session shows that name in the tab title instead of just the model name — matching the sidebar. The chat header was refreshed too: a brand-coloured model badge and cleaner line icons.
- While a chat is starting up, the panel now shows a branded loading screen with the agent's logo, following your VS Code colour theme.

### Fixed

- Running several sessions of the same agent in one folder (for example two Codex sessions), or reopening a session, now reliably continues the correct conversation — previously a session could occasionally get mixed up with another or start fresh instead of resuming.
- Long conversations no longer drop the most recent turns from the context AgentBridge injects each turn — when that block exceeded the CLI hook's size limit it was truncated from the bottom, so the newest (most relevant) turns could go missing unpredictably. The block is now ordered newest-first and trimmed from the oldest, so recent context always survives.
- Fixed a glitch in Codex sessions where AgentBridge's internal context could leak onto the screen or cut terminal output short — the injected context is now always collapsed to a single hidden line, and its marker text appearing in the conversation no longer breaks the display.

## [0.4.0] — 2026-06-17

### Added

- Long-term memory — AgentBridge now keeps a profile of durable knowledge that carries across projects (your role, your conventions, the repos and domains you work in). It automatically proposes things worth remembering from your conversations; you approve or dismiss each in the new "Long-term memory" sidebar view, and approved notes are surfaced into relevant prompts automatically. Open the profile folder to edit notes as plain Markdown. Auto-suggestion can be turned off in settings if you'd rather it not spend background CLI usage.

### Fixed

- Sessions restore correctly after restarting the IDE — with Codex or Antigravity chats open, restarting the IDE could reopen them as empty new sessions instead of resuming your previous conversation (closing and reopening the tab worked around it). Restored sessions now resume reliably.
- Sidebar no longer briefly shows duplicate sessions on restart — during restart the session list could momentarily appear doubled before settling back. The list now updates cleanly.
- Session hover tooltip no longer shows a misleading "Turns: 0" — the session list's hover tooltip always read "Turns: 0" because per-session turn counts are no longer kept in the session data. The inaccurate line was removed.
- Background memory refinement could get permanently stuck after updating the Antigravity CLI — refinement rebuilds its isolated environment when the CLI changes, but read-only files the CLI left behind (a Go module cache) blocked the rebuild, so memory stopped updating until the environment was cleared by hand. The rebuild now clears read-only files first and recovers on its own.

## [0.3.0] — 2026-06-11

### Added

- English UI — the extension's interface is now available in English and follows the IDE's display language (English or Korean).
- Toggle Claude for background refinement — a new setting (`agentbridge.refine.useClaude`) controls whether memory refinement may use Claude. Claude's headless refine (`claude -p`) consumes separate API credits rather than your subscription, so turn it off to keep refinement on the other CLIs (or skip it) and avoid unexpected charges. On by default (unchanged behavior); interactive Claude sessions are unaffected.

### Fixed

- Codex and Antigravity sessions resume reliably even after a delay — if you opened a session and didn't send your first message for a while, the session could later fail to resume (a brand-new session opened instead) and that first input could be lost. The session is now tracked for as long as the chat is open, so it resumes correctly no matter when you send the first message.

## [0.2.1] — 2026-06-11

### Changed

- Apple Silicon only — the extension is published for Apple Silicon (arm64) Macs only.
- Less aggressive memory compaction — the size threshold for compaction was too low, so conversation turns were being summarized (compacted) almost every turn. The threshold and the per-turn detail caps were raised so that a normal turn is now preserved nearly in full, and your conversation history keeps much more detail before any compaction kicks in.
- Hardened IR isolation — IR (memory) refinement for agy and codex now runs only in an isolated environment. If that environment can't be prepared, the refinement is skipped instead of falling back to a non-isolated run, so it never leaves stray files in your real CLI config directories.

### Fixed

- Duplicate context on a session's first turn — on the very first message of a session, the working memory was being injected twice, because the CLI hook registered both a session-start event and a per-prompt event. The session-start registration was removed (the per-prompt hook already injects it and keeps it fresh on every turn), and leftover managed hook entries from older versions are now cleaned up.
- Refine could stay blocked after an abnormal exit — if the app crashed or was replaced mid-refine, a leftover lock could block further memory refining for up to 5 minutes. It now recovers immediately when the process that held the lock is gone.
- Background refinement could interrupt session resume on macOS — on macOS, background memory refinement could occasionally prevent an in-progress session from resuming, sometimes starting a new conversation instead. Sessions now continue more reliably.

## [0.2.0] — 2026-06-08

### Added

- Automatic editor group lock for the chat panel — when the chat panel opens, the editor group it belongs to is automatically locked, so files opened from the explorer no longer cover the chat view and always open in the code area instead. If you don't want the lock, click the group's lock icon to release it; a released group is never locked again.
- CLI usage (quota) memory — when a CLI hits its usage limit during refine, this is remembered so the next refine skips that CLI and uses a different one.

### Changed

- Unified (shared) memory store — opening the same project folder from either the IDE extension or the Desktop app shares the same working memory (refined memory and conversation history). The CLI hook also uses a helper in a shared location, so the two apps' settings no longer overwrite each other.
- The Desktop app, extension, and shared core have been unified into a single repository ([h-taek/AgentBridge](https://github.com/h-taek/AgentBridge)). The extension's features and usage remain the same.
- Unified session data storage structure — workspace/session information that used to be split across two files is now consolidated into one. Existing data is automatically migrated to the new structure on first read, so no manual action is needed.
- Improved conversation history accuracy — conversation history is now built by directly reading the transcript each AI CLI leaves behind, removing the limitations of the previous screen-scraping-and-guessing approach (answers left empty or conversations cut off mid-way being dropped). It records only when an answer has fully completed, and conversations interrupted partway still preserve whatever progress was made.

### Fixed

- Restored Antigravity conversation continuation — a recent Antigravity CLI update changed how conversations are saved, which broke continuing a previous conversation when reopening a tab; this is now fixed. Also fixed temporary conversation files not being cleaned up after refine. It works the same on pre-change versions of the Antigravity CLI.
- Prevented data duplication on refine failure — fixed an issue where, if the history update failed during refine, the same content could be left duplicated in both the memory archive and the conversation history.
- Resolved Antigravity refine temporary data buildup — fixed an issue where temporary directories and Antigravity conversation history piled up without being cleaned on every refine.
- Mitigated broken fragments accumulating over past output when the chat view re-rendered excessively during panel resizing — it now re-renders only once when resizing finishes. Note: past output not fitting the new width after a resize is a structural limitation common to all terminals; closing and reopening the tab re-renders it at the current width.

## [0.1.6] — 2026-05-24

### Changed
- Synced the package lock file's metadata with the current release information. No dependency changes.

### Fixed
- Fixed the screen freezing immediately after hook context injection in codex sessions (stabilized PTY output filter matching)
- Shortened the context-blocking safety net (watchdog) timeout (5s → 1s) — reduces freeze time even in extreme match-failure cases
- Fixed some characters being incorrectly displayed with a different glyph after chat output accumulated (applied an upstream terminal renderer patch)
- Fixed the Memory refinement fallback notification asserting "CLI not installed" regardless of the actual reason (not installed / quota / response parsing failure) — changed to report each reason accurately

### Removed
- Removed unused internal code and static-analysis configuration. No runtime behavior changes.

## [0.1.5] — 2026-05-24

### Changed
- README rewrite (no runtime behavior changes)

## [0.1.4] — 2026-05-24

### Added
- Shift+Enter multi-line input (safe even during Korean IME composition)
- Automatic restore of the most recent chat tab on IDE restart (conversation continues via `--resume`)
- Chat terminal ANSI colors follow the IDE color theme and update live when the theme switches
- Setting `agentbridge.memory.maxArchiveSnapshots` — user-configurable number of IR snapshots to retain (default 15)

### Changed
- The chat panel is placed to the right of the active editor — if a split already exists, it accumulates as a tab in the rightmost column
- Fixed item count (3) and duplicate prevention in the Refine priority setting — "Add Item" is disabled in the settings UI, preventing the same model from being tried twice
- Accumulated IR snapshots are automatically pruned oldest-first when they exceed the limit (`maxArchiveSnapshots`)
- Reorganized the Memory panel layout

### Fixed
- Fixed the sidebar being forcibly switched to AgentBridge when clicking a chat tab while using another sidebar (Explorer, etc.)

## [0.1.3] — 2026-05-23

### Changed
- README rewrite and deployment metadata cleanup (no runtime behavior changes)

## [0.1.2] — 2026-05-23

### Fixed
- PTY stability issue where hook context handling froze in some CLIs' TUI rendering environments

## [0.1.1] — 2026-05-23

### Changed
- README rewrite, marketplace metadata enhancements, packaging artifact cleanup (no runtime behavior changes)

## [0.1.0] — 2026-05-23

First public release (Open VSX). The core behavior of the original [AgentBridge_App](https://github.com/h-taek/AgentBridge_App) was ported to fit the IDE extension environment — see [features reduced relative to the original](README.md#원본-대비-축약된-기능).
