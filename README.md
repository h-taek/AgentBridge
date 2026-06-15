<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/extension/media/icon-dark.svg" />
    <img src="apps/extension/media/icon-light.svg" width="220" alt="AgentBridge logo" />
  </picture>
</p>

# AgentBridge

> A tool that automatically carries your working context across multiple AI coding agents (Claude · Codex · Antigravity). Available on macOS (Apple Silicon) as a Desktop app and an IDE extension.

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.4.x-orange.svg">
  <img alt="Desktop" src="https://img.shields.io/badge/desktop-Apple%20Silicon-lightgrey.svg">
  <img alt="Extension" src="https://img.shields.io/badge/extension-Apple%20Silicon-007ACC.svg">
</p>

<p align="center"><a href="README.ko.md">한국어</a></p>

---

## What it solves

It solves the **context handoff** problem that arises when you use Claude Code CLI, Codex CLI, and Antigravity CLI side by side — the problem where your working context is lost every time you switch models.

AgentBridge opens multiple model tabs *simultaneously* within a single workspace, and on every user message it automatically injects the **IR (Intermediate Representation, "shared memory")** through a hook mechanism. Even when you switch models, *how far you've gotten and what you've decided* is never lost.

On top of this short-term memory, AgentBridge also builds a **long-term memory (global context)**: durable facts about you and how you work (your role, conventions, workflows…) are auto-proposed from your conversations, and once you approve them they persist across *all* workspaces and sessions — like ChatGPT/Claude memory, but local and shared across your CLIs.

Each CLI's default behavior (permission dialogs, tool approval flow, session management) is preserved as-is. AgentBridge does not limit the CLI's native features.

## Who it's for

- People who alternate between Claude · Codex · Antigravity and are frustrated at having to re-explain their working context every time they switch models
- People who want to work by placing several AI CLIs on one screen and comparing them
- People who want to solve only the context handoff problem with their own existing CLIs and subscriptions, without a separate backend or account

## Features

- **Multi-agent workspace** — Open Claude · Codex · Antigravity CLI tabs simultaneously in a single workspace.
- **Automatic IR handoff** — On every message the shared memory (IR) is injected via a hook, so your working context is never lost when you switch models.
- **Free/low-cost refine** — The default policy performs memory updates headlessly with the Antigravity free-tier CLI, so it consumes no main-model tokens.
- **Memory panel** — See the current memory · previous snapshots · turn flow at a glance, and run manual refine and reset.
- **Long-term memory (global context)** — Durable knowledge (your role · conventions · workflows · …) is auto-proposed from conversations; you approve or dismiss, and approved memory is shared across every workspace. Auto-proposal can be toggled off in settings.
- **Session persistence + resume** — Even after you quit and relaunch the app, native `--resume` continues your previous conversation as-is.
- **Desktop·extension memory sharing** — If the project folder is the same, both apps use the same working memory (memory · conversation history).
- **User-asset isolation** — Without modifying global settings, it embeds only the user's own already-authenticated CLIs.

## How it works — three principles

1. **Use the user's own CLIs as-is** — It embeds the *user's already-authenticated CLIs* via PTY. There is no separate AgentBridge backend or account system, and main-model costs are incurred only within the user's own subscription.
2. **Automatic IR handoff** — The IR is automatically injected via a hook on model switches and on every message. The user updates the IR with an explicit refine action, or it is refined automatically once the compaction threshold is crossed. IR refine is performed by **calling a free/low-cost CLI headlessly**, so it consumes 0 main-model tokens. The refine policy can be set to one of four levels — `priority` / `fixed` / `active model` / `off` — and automatically falls back to the next CLI when a quota is near or exceeded.
3. **User-asset isolation** — Global settings (`~/.claude` / `~/.codex` / `~/.agents`) are not modified. In the workspace cwd, only CLI native config (`.codex/hooks.json` / `.codex/config.toml` / `.agents/hooks.json`) is added via marker-block merge, while claude operates without touching the cwd (using the `--settings <isolated path>` flag).

## Prerequisites

Because AgentBridge embeds the CLIs in your environment, the CLI for the model you want to use must be installed separately. At least one is required.

| Model | Install guide | Authentication |
|---|---|---|
| Claude (`claude`) | [claude.ai/code](https://www.claude.com/product/claude-code) | Follow the prompts after running `claude` |
| Codex (`codex`) | [openai.com/codex](https://openai.com/codex) | Follow the prompts after running `codex` |
| Antigravity (`agy`) | [antigravity.google](https://antigravity.google/product/antigravity-cli) | `agy /auth` or an environment variable |

All three CLIs must be on your PATH. It works even if only some are installed, but to perform IR refine on the free tier, **installing + authenticating Antigravity (`agy`)** is recommended (otherwise it falls back to the active model with a token-cost warning).

## Available as

- macOS (Apple Silicon) Desktop app — [install & usage](apps/desktop/README.md)
- macOS (Apple Silicon) IDE extension — Works in VS Code · Cursor · Antigravity IDE and other VS Code-family IDEs. [install & usage](apps/extension/README.md)

## Privacy

AgentBridge has no server or backend of its own; it only mediates the CLIs in the user's own environment. The data flow is limited to the following two paths only.

- **Main-model messages** — Sent, through each CLI the user has authenticated (claude / codex / agy), only to the model backend that CLI originally communicates with (Anthropic / OpenAI / Google). AgentBridge does not detour through any separate service in between.
- **IR refine** — Performed by headlessly calling the user-authenticated CLI selected by the refine policy (Antigravity by default). The refine request is sent only to the backend that CLI originally communicates with, and the resulting IR JSON is stored on the user's machine.

Nothing is sent to any external service (a backend of our own, analytics/telemetry, third-party summarization, etc.) beyond the two paths above. Workspace metadata · conversation history · memory (IR) · turns logs · replay buffers are all stored only on the user's machine.

## Data location

The Desktop and extension share the same location under `~/.agentbridge/` — if the project folder is the same, memory refined in one app is seen as-is in the other (V-12 unified store).

```
~/.agentbridge/                              ← AgentBridge metadata (shared by Desktop·extension)
├── workspaces/<workspaceId>/
│   ├── workspace.json
│   ├── ir.json                             ← compressed shared memory (short-term)
│   ├── turns.jsonl                         ← raw turn log
│   ├── archive/                            ← compaction snapshots
│   ├── sessions/<sessionId>/replay.log     ← PTY raw bytes (per tab)
│   └── settings/claude-settings.json       ← target of the claude --settings flag
└── global/profiles/default/                ← long-term memory (global profile, shared)
    ├── proposals/                          ← pending auto-proposals (awaiting approval)
    └── docs/<category>/<slug>.md           ← approved long-term memory

<user workspace cwd>/           ← user project
├── .codex/hooks.json           ← codex hook (marker-block merge)
├── .codex/config.toml          ← codex hook enable (marker-block merge)
├── .agents/hooks.json          ← agy (Antigravity) hook (marker-block merge)
└── (user files — unrelated to AgentBridge)
```

## License

[MIT](LICENSE) © h-taek

The long-term memory module adapts code from [gc-tree](https://github.com/handsupmin/gc-tree) (MIT). See [NOTICE](NOTICE).
