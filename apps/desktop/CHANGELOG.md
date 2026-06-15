# Changelog

This project follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 1.1.0 format and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<p align="center"><a href="CHANGELOG.ko.md">한국어</a></p>

## [Unreleased]

### Added

- Long-term memory — AgentBridge now keeps a profile of durable knowledge that carries across projects (your role, your conventions, the repos and domains you work in). It automatically proposes things worth remembering from your conversations; you approve or dismiss each in the new Long-term memory tab, and approved notes are surfaced into relevant prompts automatically. Open the profile folder to edit notes as plain Markdown. Auto-suggestion can be turned off in Settings if you'd rather it not spend background CLI usage.

### Changed

- Usage is refreshed at app startup — when you launch the app, AgentBridge checks each CLI's remaining usage in the background (skipping any checked within the last 30 minutes), so the usage display reflects current values right after launch instead of the previous session's.

### Fixed

- Antigravity usage (quota) is read correctly after its on-screen format changed — Antigravity's `/usage` now shows a multi-group "Models & Quota" layout with decimal percentages, which broke the background usage check (a full quota could be misread as exhausted). The reader was updated to the new format, so Antigravity's remaining usage is reported correctly again.

## [0.3.0] — 2026-06-11

### Added

- English UI — the desktop app's interface is now fully available in English, with a Korean/English toggle in Settings (Language).
- Toggle Claude for background refinement — a new setting controls whether memory refinement may use Claude. Claude's headless refine (`claude -p`) consumes separate API credits rather than your subscription, so turn it off to keep refinement on the other CLIs (or skip it) and avoid unexpected charges. On by default (unchanged behavior); interactive Claude sessions are unaffected.

### Fixed

- Codex and Antigravity sessions resume reliably even after a delay — if you opened a session and didn't send your first message for a while, the session could later fail to resume (a brand-new session opened instead) and that first input could be lost. The session is now tracked for as long as the chat is open, so it resumes correctly no matter when you send the first message.
- Usage (quota) for Antigravity and Codex is reported again — the background usage check couldn't read Antigravity's or Codex's remaining quota, so it showed nothing. Antigravity was getting stuck on a first-run setup screen in its isolated environment, and Codex's status panel loads its limits asynchronously (the first read just said "refresh requested"). Both are handled now, so remaining usage is shown for all three CLIs.

## [0.2.1] — 2026-06-11

### Changed

- Apple Silicon only — AgentBridge is distributed for Apple Silicon (arm64) Macs only.
- Less aggressive memory compaction — the size threshold for compaction was too low, so conversation turns were being summarized (compacted) almost every turn. The threshold and the per-turn detail caps were raised so that a normal turn is now preserved nearly in full, and your conversation history keeps much more detail before any compaction kicks in.
- Hardened background isolation — IR (memory) refinement and usage (quota) checks for agy and codex now run only in an isolated environment. If that environment can't be prepared, the work is skipped for that cycle instead of falling back to a non-isolated run, so background work never leaves stray files in your real CLI config directories.

### Fixed

- Duplicate context on a session's first turn — on the very first message of a session, the working memory was being injected twice, because the CLI hook registered both a session-start event and a per-prompt event. The session-start registration was removed (the per-prompt hook already injects it and keeps it fresh on every turn), and leftover managed hook entries from older versions are now cleaned up.
- Refine could stay blocked after an abnormal exit — if the app crashed or was replaced mid-refine, a leftover lock could block further memory refining for up to 5 minutes. It now recovers immediately when the process that held the lock is gone.
- Background refinement could interrupt session resume on macOS — on macOS, background memory refinement could occasionally prevent an in-progress session from resuming, sometimes starting a new conversation instead. Sessions now continue more reliably.

## [0.2.0] — 2026-06-08

Monorepo integration + unified version track jumps Desktop from 0.0.x → 0.2.0. Shared store, improved conversation history accuracy (transcript-based capture), broader usage measurement across all three CLIs.

### Added

- Archive snapshot retention count setting — You can now set an upper limit, in settings, on the number of past IR snapshots that accumulate in the Memory panel (default 15). Anything beyond it is automatically pruned oldest-first, so the Memory panel doesn't grow indefinitely.

### Changed

- Unified (shared) memory store — Opening the same project folder from either the Desktop app or the IDE extension shares the same working memory (refined memory and conversation history). What the two apps used to remember separately is now merged into one. The CLI hook also uses a helper in a shared location so the two apps' settings don't overwrite each other.
- Unified project repository — The Desktop app and IDE extension, together with the shared core, are now unified into a single repository ([h-taek/AgentBridge](https://github.com/h-taek/AgentBridge)). App features and usage remain the same.
- Broader CLI usage measurement — Post-refine usage measurement expanded from the single CLI used for refining to all three CLIs. The Memory panel's usage card now always stays up to date.
- Improved conversation history accuracy — Conversation history is now built by directly reading the conversation record each AI CLI leaves behind, eliminating the limitations of the screen-scraping-and-guessing approach (answers left blank, or conversations cut off midway being dropped). It records only at the point an answer is fully complete, and conversations stopped midway still preserve the content that was produced.

### Fixed

- Antigravity conversation continuation recovery — A recent Antigravity CLI update changed how conversations are stored, which broke continuing a previous conversation when closing and reopening a tab. This is fixed, along with the issue where temporary conversation files after refining and leftover files on session deletion were not cleaned up. It behaves identically even on environments using the pre-change version of the Antigravity CLI.
- Blocked data duplication on refine failure — Prevented the issue where, if a record update failed during refining, the same content could be left duplicated in both the memory archive and the conversation history.
- Fixed missing Antigravity usage measurement — Fixed the issue where usage was not measured in the partially-used state. It is now measured across the full range.
- Antigravity refine temporary-data cleanup — Fixed the issue where some temporary data was left uncleaned after refining.
- Prevented concurrent manual refine — Blocked the issue where automatic cleanup could run overlapping with an in-progress manual refine.
- Reduced screen corruption during window resize — Reduced the phenomenon where, while dragging the window to resize, the chat screen was excessively re-rendered, piling broken screen fragments over past output. It now re-renders only once, at the point resizing ends. Note: after a size change, past output whose line wrapping no longer matches the new width is a structural limitation common to all terminals; closing and reopening the tab re-renders it cleanly at the current width.

## [0.0.5] — 2026-05-26

Stabilized the output filter of the memory-injection hook + prevented global hook overwrites.

### Security

- CLI global config directories cannot be designated as workspaces — The home directory itself and subdirectories of CLI config directories such as `~/.codex` and `~/.agents` cannot be registered as workspaces. Attempting to register one is blocked with a clear error.

### Changed

- Strengthened the memory-injection hook output filter — When the codex CLI inserted control characters inside a hook context block while re-rendering the screen, the filter could miss the block boundary and expose the inner text as-is. The matching logic was redesigned so it is always masked reliably, regardless of screen re-rendering.
- Output-stall auto-recovery safety net — Fixed the issue where, in the extreme situation where the termination signal of a hook context block never arrived, the chat screen could stall indefinitely. It now auto-recovers within 1 second, so the user input/output flow is not interrupted.

## [0.0.4] — 2026-05-22

ad-hoc signed beta. Gemini → Antigravity rebrand + security hardening + usability improvements.

### Security

- Removed `window.electron` general-purpose IPC exposure — Previously the preload also exposed the general-purpose `ipcRenderer.invoke/send/on`, allowing the curated `window.agentbridge` API to be bypassed. The renderer now uses only explicit methods.
- Removed the `pty:start` arbitrary-command-execution IPC — Removed the PTY spawn channel that was exposed but unused by the UI. Session creation is unified through `sessions:create/open`.
- workspaceId / sessionId path validation — Added a UUID regex + workspaces-root prefix guard. This blocks access to directories above userData caused by malformed identifiers.

### Changed

- Gemini CLI → Antigravity rebrand — As Google announced the Antigravity CLI (`agy`) as the successor to the Gemini CLI, all commands, labels, and logos AgentBridge uses were updated. Existing Gemini sessions and settings are automatically migrated and remain compatible.
- Redesigned the summary policy into 4 modes — `priority` (try in the configured order, fall through to the next CLI on failure) / `fixed` (a single CLI only) / `active model` (the most recently chatted CLI) / `off` (no summarizing). In priority/fixed, the lowest-cost model is selected automatically. The existing `auto`/`gemini-flash` policy is automatically migrated to `priority`.
- Redesigned the Memory panel Refine/Quota card — Lists all three CLIs' usage in a single row, highlighting only the active CLI to be used for the next refine with a name and a status badge.
- Settings → Check for updates — Previously this was a simple link that opened the GitHub Releases page in an external browser. Now clicking it invokes an actual update check, and the progress (checking → new version found → downloading N% → done / up to date / error) is shown live in the row. A separate "View release notes" row takes over the role of the external link to the GitHub page. (At the ad-hoc signing stage only the download works — full automatic installation becomes possible after formal notarization.)
- Top-tab ⋯ overflow menu — Even with many tabs, a single row is maintained, and tabs that don't fit on screen can be selected from the ⋯ button's dropdown.
- Minimum window 504×327 + auto sidebar collapse on narrow screens — Reduced from the previous minimum of 820×520. On a narrowed screen, both sidebars collapse automatically to secure the body area (a state explicitly toggled by the user takes priority).
- Memory panel "Reset" now also clears the archive — Previously archive snapshots were preserved. Consolidated after confirming that a user's intent when pressing "Reset" is usually to clear everything.
- Hook fallback path cleanup — The hook config for agy sessions moved to the `.agents/hooks.json` location. The marker entry in `.gemini/settings.json` of existing Gemini sessions is automatically cleaned up when agy is installed.

### Added

- Direct usage measurement across all three CLIs — Right after a refine, the used CLI is launched in the background to directly check the current quota via the `/usage` · `/status` slash commands. You can also immediately measure any CLI with the "Check now" button in the settings panel. When near/over the limit, the next refine automatically falls back to a different CLI.
- Measurement session trace cleanup — A CLI session launched temporarily for measurement has even its own conversation file deleted the moment it terminates. The next time you open the same CLI externally via `--resume` or similar, the measurement session is not visible.
- Settings changes apply immediately — When you change the refine policy in one panel/window, the active-CLI display in all other places refreshes immediately.
- Memory-injection disabled badge — A session where automatic IR injection doesn't work due to a hook install failure shows a ⚠ badge on its tab. Previously it was silent and behaved like an ordinary CLI, making it hard to notice that a core feature was disabled.
- Session ordering + reorder motion — The most recently chatted session moves to the top of the left sidebar / the far left of the top tabs. When the ordering changes, a smooth slide motion is applied (View Transitions API, 220ms). For `prefers-reduced-motion` users it applies instantly.
- Turn-record detail-level setting — In Settings → "Turn record detail", choose among `full` / `compact` / `minimal`. The character count at which the assistant body is truncated varies by level (full ~50KB / compact ~500 chars / minimal ~200 chars).

### Fixed

- Korean IME Shift+Enter race — The issue where pressing Shift+Enter during Korean input dragged the last character to the next line, or caused a double line break. Fixed to track input state in line with how the macOS IME double-fires keydown.
- Workspace path input handling — The issue where entering a path containing escapes, quotes, or `~` — such as Finder's "Copy as Pathname" or zsh `Mobile\ Documents` — caused the first session spawn to fail with ENOENT. It is now automatically converted to a proper cwd, and a non-existent path is rejected with a clear error at creation time.

### Added — Diagnostics

- Auto-update progress broadcast — Every state between update check → download → awaiting install is propagated over a single channel, so it is displayed identically in any window.
- Quota measurement debug log — On measurement failure, part of the response body is left in main.log so regressions from CLI TUI changes can be diagnosed quickly.

## [0.0.3] — 2026-05-13

ad-hoc signed beta. Corrected the memory snapshot time display + strengthened diagnostic logs.

### Fixed

- Memory panel archive card time display — Previously it displayed "the time this snapshot was pushed to the archive" (`archivedAt`), so the most recent archive and the current memory appeared at the same time. Corrected to the actual time the IR was refined (`ir.meta.updatedAt`), so the current memory and the archive cards are chronologically distinguished.

### Changed

- PTY slicer CJK whitespace preservation — Mitigated the issue where `compactBody`'s trailing-whitespace removal logic also shaved off whitespace between CJK. Simplified to trim only line breaks.

### Added — Diagnostics

- renderer → main.log unification — The preload loads `electron-log/preload` so renderer-side logs flow into main.log. Added breadcrumbs to App.tsx's core handlers (`handleSelectTab`/`closeSession`/`closeAllAttachments`/`handleGoHome`/`handleHomeSubmit`/`handleCreateWorkspace`/`handleOpenCard`).
- `sessions:close source` field — Added origin identification (`sidebar-trash` / `tab-x` / `workspace-switch` / `workspace-create` / `workspace-add` / `home-go` / `home-submit` / `workspace-removed` / `unknown`) to the IPC request and logs it alongside in main.log. When a session-disappearance incident occurs, the origin can be traced immediately.
- XtermView event log — Warns on mount / unmount / `isActive` transitions / the active-rAF's fit·resize·refresh / PTY onExit / dispose race. Diagnostic material for tab-switch freeze incidents.

## [0.0.2] — 2026-05-13

ad-hoc signed beta. Fixed two defects found in the v0.0.1 package build + pre-introduced the auto-update channel.

### Fixed

- The issue where the Hook system's automatic IR injection always failed in the package build — The `agentbridge-memory` helper binary path was incorrectly referenced as `process.resourcesPath/bin/...`, so it fell back to spawning without the hook. Corrected to `app.asar.unpacked/resources/bin/...`. Differentiator 3 (automatic IR handoff) now works correctly in the package build.
- The issue where Gemini quota automatic background probe terminated immediately in the package build — The probe PTY spawn was missing the login shell PATH, exiting with `env: node: No such file or directory` (exit 127). Injected the adapter's shared env builder (`buildAdapterEnv`) into the probe flow. The footer auto-capture + automatic fallback flow now works correctly.

### Added

- Auto-update (electron-updater) — Polls the `latest-mac.yml` channel of GitHub Releases right after boot + every 6 hours. On finding a new version, it downloads in the background and auto-installs on the next quit. Progress/errors accumulate in `~/Library/Logs/agentbridge/main.log`. At the ad-hoc signing stage only the download works; after passing the Apple Developer ID certificate + notarytool, the update flow works.

## [0.0.1] — 2026-05-13

First public release. macOS only, ad-hoc signed build.

> First-run notice for external users: because it is ad-hoc signed, macOS Gatekeeper blocks it.
> Work around it with one of the following:
>
> 1. Terminal: `xattr -dr com.apple.quarantine /Applications/AgentBridge.app`
> 2. System Settings → Privacy & Security → "Open Anyway"

### Added — Core features

- Multi-agent workspace — Within a single workspace, you can open Claude · Codex · Gemini CLI tabs simultaneously. xterm.js embeds each CLI's interactive screen as-is.
- IR automatic handoff — On every user message, the IR (shared memory) is automatically injected via the hook mechanism. The work context isn't lost even when you switch models.
- IR refine — Calls the Gemini free tier headlessly to update the IR. It does not consume main-model (Claude/Codex) tokens. It runs automatically when the compaction threshold (turn count/bytes) is exceeded, or can be run manually via the Memory panel button.
- Memory panel — Collapsible cards in 3 groups in the right sidebar: AI instructions / Refine·Quota / Memory. You can see the current IR · previous snapshots · turn flow at a glance, and can delete individual IR cards, reset the memory, and refine manually.
- Session persistence + resume — Every workspace/session is saved automatically, and on app restart you can pick up previous conversations as-is via native CLI resume (`claude --resume` / `codex resume` / `gemini --resume`).
- User-asset isolation — Global config (`~/.claude` / `~/.codex` / `~/.gemini`) is not modified. To the workspace cwd, only the 3 CLI native configs (`.codex/hooks.json` / `.codex/config.toml` / `.gemini/settings.json`) are added via marker-block merge. claude operates without touching the cwd.

### Added — Additional features

- Drag-and-drop attachments — Dropping a file onto the xterm area automatically pastes its absolute path into the model input. Bracketed paste blocks auto-submit, so the model doesn't send until the user presses Enter themselves. Up to 20 files at once.
- Multi-window — A workspace can be opened in a separate BrowserWindow. ⌘N for a new empty window, "Open in new window" from the left sidebar's right-click menu. A one-workspace = one-window policy blocks duplicate opens.
- Built-in terminal session — A plain zsh PTY tab. Usable for checking the CLI environment or chores without spawning a model.
- Home-screen bootstrap — When you enter a message on the home screen at app launch, it automatically creates a workspace in the `~/AgentBridge/Chat-YYMMDD-HHMM/` folder and starts the model.
- Gemini quota automatic fallback — Automatically detects `X% used` in the Gemini CLI footer and automatically falls back to the active model at 95% or higher. It notifies via a UI badge on entering the threshold, and auto-clears at UTC midnight.
- Workspace/session inline rename — Edit the name directly via the pen icon in the left sidebar or the right-click menu. IME-composition safe.
- codex hook trust guidance — Guides codex's `/hooks` manual approval procedure via a UI banner.

### Added — Shortcuts

- ⌘B / ⌘⌥B — Toggle left/right sidebar
- ⌘N — New empty window (macOS Safari/Finder standard)
- ⌘Q — Quit app
- Enter / ⇧Enter — Home-screen send / line break
- Esc — Close modal · go back from sub-page
- ⇧Enter (inside terminal) — Line break (equivalent to Option+Enter)

### Known limitations

- Multilingual UI (English, etc.) and the light theme are locked (language fixed to `ko` / theme fixed to `dark`).
- No custom shortcuts, local LLM adapter, or drag-and-drop folder support.
- No build for platforms other than macOS (Windows/Linux).
