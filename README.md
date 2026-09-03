<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/assets/brand/agentbridge-dark.svg" />
    <img src="packages/assets/brand/agentbridge-light.svg" width="220" alt="AgentBridge logo" />
  </picture>
</p>

# AgentBridge

> A tool that carries your working context across multiple AI coding agents (Claude · Codex · Antigravity), and lets one of them put the others to work. Available on macOS (Apple Silicon) as an IDE extension.

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.6.x-orange.svg">
  <img alt="Extension" src="https://img.shields.io/badge/extension-Apple%20Silicon-007ACC.svg">
</p>

<p align="center"><a href="README.ko.md">한국어</a></p>

---

## What it solves

It solves the **context handoff** problem that shows up when you use Claude Code CLI, Codex CLI, and Antigravity CLI side by side — the problem where your working context is lost every time you switch models.

AgentBridge opens several model tabs in one workspace and keeps a shared record of the work: a rolling summary of where you are, the raw turns behind it, and durable knowledge about you and the repository. The agent **fetches what it needs** — a hook adds a short instruction to each turn, and the agent calls AgentBridge's command-line tool when it wants the summary, the recent turns, or your long-term memory. Switching models does not mean starting over.

From 0.6 the same wiring runs in the other direction: the agent you are talking to can **spawn helper agents**, hand them work, read what they actually did, and merge it back — without you relaying messages between tabs.

Each CLI's own behavior (permission prompts, tool approval, session management) is left alone. AgentBridge does not take away what the CLI already does.

## Who it's for

- People who alternate between Claude · Codex · Antigravity and are tired of re-explaining where they are every time they switch
- People who want several AI CLIs on one screen, working on the same thing
- People who want to solve the handoff problem with their own CLIs and their own subscriptions, without another backend or account

## Features

- **Multi-agent workspace** — Claude · Codex · Antigravity tabs open at the same time in one workspace, with a session tree that shows what each one is doing.
- **Context by pull** — A hook adds a short instruction; the agent asks for the summary, the raw turns, or your memory when it needs them. The injected block stays around 1 KB, so recent turns are never squeezed out of it.
- **Subagents** — The agent can start helper agents from inside a session. Each opens in its own tab, nested under the session that started it, and the main agent sends follow-ups and reads their transcripts.
- **Optional isolation** — A helper can run in its own git worktree, so two of them can edit the same file. Its worktree shows up in the built-in Source Control view while it runs, and its work is merged back all at once — or not at all, leaving your folder untouched if anything conflicts.
- **Long-term memory** — Durable facts about you (your role, conventions, workflows) and about the repository. The agent proposes them as it works; nothing becomes memory until you approve it.
- **Context panel** — The current summary, the raw turns behind it, and previous snapshots, in one place.
- **Free/low-cost background work** — Summarizing and naming run headlessly on the CLI you choose, by default the one you are already talking to.
- **Session persistence** — Close the IDE and come back; sessions resume through each CLI's own `--resume`.
- **Nothing in your project folder** — Hooks live in your own agent settings, not in your repository. AgentBridge writes nothing into your working tree.

## How it works — three principles

1. **Your own CLIs, as they are.** AgentBridge runs the CLIs you have already authenticated, in a terminal it hosts. There is no AgentBridge backend and no AgentBridge account; model costs stay inside your own subscription.
2. **Context is pulled, not pushed.** The hook carries an instruction, not a copy of your memory. The agent decides what it needs and asks for it, which keeps the prompt small and the record complete. Summarizing runs headlessly on a CLI of your choosing, so it costs no main-model tokens; the policy has four settings (`priority` / `fixed` / `active` / `off`) and falls back to the next CLI when a quota runs out.
3. **Your repository stays clean.** Hooks and the agent skill install into your user-level agent settings — `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` — as marked blocks that leave your own settings alone. Everything AgentBridge stores lives under `~/agentbridge/`. Run `agentbridge uninstall` to take the hooks back out.

## Prerequisites

AgentBridge runs the CLIs in your environment, so the CLI for the model you want must be installed separately. At least one is required.

| Model | Install guide | Authentication |
|---|---|---|
| Claude (`claude`) | [claude.ai/code](https://www.claude.com/product/claude-code) | Follow the prompts after running `claude` |
| Codex (`codex`) | [openai.com/codex](https://openai.com/codex) | Follow the prompts after running `codex` |
| Antigravity (`agy`) | [antigravity.google](https://antigravity.google/product/antigravity-cli) | `agy /auth` or an environment variable |

All three must be on your PATH. It works with only some installed, but for background work on a free tier, **installing and authenticating Antigravity (`agy`)** is recommended — otherwise it falls back to the model you are talking to, with a warning about token cost.

## Installation

Search for *AgentBridge* in the VS Marketplace and install. VS Code-family IDEs such as Cursor and Antigravity IDE install it the same way from their own extensions view.

## Usage

1. Command Palette (`Cmd+Shift+P`) → **AgentBridge: New Model Session**
2. Pick a model — the chat tab opens
3. The AgentBridge icon in the Activity Bar shows the session tree, the Context panel, and pending memory suggestions

To put a helper agent to work, just ask the agent in the tab: it has the tool and the instructions for starting one, checking on it, reading what it did, and merging it back.

## Settings

VS Code settings (`settings.json` or the Settings UI):

| Key | Default | Description |
|---|---|---|
| `agentbridge.refine.policy` | `active` | Which CLI does background work: `priority` / `fixed` / `active` / `off` |
| `agentbridge.refine.priorityOrder` | `[agy, codex, claude]` | Try order under the `priority` policy |
| `agentbridge.refine.fixedCli` | `agy` | CLI used under the `fixed` policy |
| `agentbridge.refine.useClaude` | `true` | Allow Claude for background work. Headless `claude -p` bills API credits rather than your subscription — turn this off to keep Claude out of it |
| `agentbridge.turns.assistantDetail` | `compact` | How much of each answer is kept in the turn log: `full` / `compact` / `minimal` |
| `agentbridge.memory.maxArchiveSnapshots` | `15` | How many previous snapshots to keep; older ones are dropped |

## Privacy

AgentBridge has no server of its own. It mediates the CLIs already in your environment, and the data flow is limited to these paths.

- **Your messages** — Sent through the CLI you authenticated (claude / codex / agy) to the backend that CLI already talks to (Anthropic / OpenAI / Google). AgentBridge does not route them anywhere else.
- **Background work** — Summarizing, session naming, and similar run by calling one of those same CLIs headlessly. The request goes only to that CLI's own backend, and the result is stored on your machine.

Nothing else leaves your machine. There is no analytics, no telemetry, and no third-party service. Session records, turn logs, memory, and terminal replay buffers are all local files.

## Data location

Everything lives under `~/agentbridge/`, keyed by the project folder.

```
~/agentbridge/
├── workspaces/<folder-name>-<hash>/
│   ├── workspace.json                  ← sessions and their state
│   ├── ir.json                         ← the working summary
│   ├── turns.jsonl                     ← raw turns
│   ├── archive/                        ← previous snapshots
│   ├── sessions/<sessionId>/           ← per tab: replay buffer, hook signals
│   └── trees/<name>/                   ← isolated subagent worktrees
├── attachments/                        ← images you paste into chat
└── global/
    ├── profiles/default/               ← what it knows about you
    │   ├── proposals/                  ← suggestions awaiting your approval
    │   └── docs/<category>/<slug>.md   ← approved
    └── projects/<repo>-<hash>/         ← what it knows about this repository
```

Your own agent settings gain a marked block for the hooks and the skill, and nothing else:

```
~/.claude/settings.json          ~/.claude/skills/agentbridge/
~/.codex/hooks.json              ~/.agents/skills/agentbridge/
~/.gemini/config/hooks.json      ~/.gemini/config/skills/agentbridge/
```

## License

[MIT](LICENSE) © h-taek
