# AgentBridge — Desktop (macOS)

> Electron-based standalone app. For the concept, how it works, and CLI requirements, see the [monorepo README](../../README.md).

<p align="center">
  <a href="../../LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Desktop" src="https://img.shields.io/badge/desktop-macOS-lightgrey.svg">
</p>

<p align="center"><a href="README.ko.md">한국어</a></p>

---

## Desktop-only features

Items the Desktop provides on top of the IDE extension.

1. **Proactive usage measurement + automatic fallback** — The Desktop measures quota with a background probe right after refining, switching to the next model *before* nearing the limit. The IDE extension only falls back in priority order *after* a refine call fails (one failure always occurs)
2. **Per-card IR deletion** — The Desktop can delete each IR section (decisions/files/commands/tests/pending) card by card. The IDE extension supports only a full reset
3. **Native file drag and drop** — On the Desktop, an OS-level drop auto-pastes the absolute path. The IDE extension creates a copy inside the project folder and passes that copy's path (the copy is auto-deleted after some time)
4. **Multi-window / built-in zsh terminal tabs** — Desktop-only. The IDE extension runs inside a single IDE instance and uses the IDE's own terminal feature

For features common to both apps (Memory panel, refine policy, automatic hook injection, etc.), see the [monorepo README](../../README.md).

## Installation

Download the `.dmg` from [GitHub Releases](https://github.com/h-taek/AgentBridge/releases).

Because the build is ad-hoc signed, macOS Gatekeeper blocks the first launch. Work around it with one of the following:

```bash
# Method 1 — Terminal
xattr -dr com.apple.quarantine /Applications/AgentBridge.app
```

```
# Method 2 — System Settings → Privacy & Security → "Open Anyway"
```

## Usage

1. Launch the app → on the home screen, enter a message + select a model → Enter
2. AgentBridge auto-creates a workspace in the `~/AgentBridge/Chat-YYMMDD-HHMM/` folder, then spawns the model
3. Within one workspace, add another model tab via the *top + model* button. Switching tabs = switching models, and the IR follows automatically
4. In the right-side Memory panel, check the current IR and previous snapshots. A manual refine / reset memory button is provided
5. From the left sidebar, enter another workspace, or right-click for "Open in new window / Rename / Delete"

## License

[MIT](../../LICENSE) © h-taek
