# AgentBridge — IDE extension

> An IDE extension for VS Code-family IDEs such as VS Code, Cursor, and Antigravity IDE. For the concept, how it works, and CLI requirements, see the [monorepo README](https://github.com/h-taek/AgentBridge/blob/main/README.md).

<p align="center">
  <a href="https://github.com/h-taek/AgentBridge/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Extension" src="https://img.shields.io/badge/extension-Apple%20Silicon-007ACC.svg">
</p>

<p align="center"><a href="README.ko.md">한국어</a></p>

---

For an overview of the features (Memory panel, refine policy, automatic hook injection, etc.), see the [monorepo README](https://github.com/h-taek/AgentBridge/blob/main/README.md).

## Installation

Search for *AgentBridge* in the VS Marketplace and install. (VS Code-family IDEs such as Cursor and Antigravity IDE can be installed the same way from their side menu.)

## Usage

1. Command Palette (`Cmd+Shift+P`) → **AgentBridge: New Model Session**
2. Select a model → open the chat panel
3. AgentBridge icon in the Activity Bar → shows the session tree and Memory panel in the left sidebar

## Settings

VS Code settings (`settings.json` or the Settings UI):

| Key | Default | Description |
|---|---|---|
| `agentbridge.refine.policy` | `priority` | Refine model selection: priority / fixed / active / off |
| `agentbridge.refine.priorityOrder` | `[agy, codex, claude]` | Attempt order for the priority policy |
| `agentbridge.refine.fixedCli` | `agy` | CLI to use under the fixed policy |
| `agentbridge.turns.assistantDetail` | `compact` | Response detail in turns.jsonl: full / compact / minimal |
| `agentbridge.memory.maxArchiveSnapshots` | `15` | Max number of IR snapshots to keep. Excess is auto-deleted oldest-first |
| `agentbridge.memory.proposalEnabled` | `true` | Auto-propose long-term memory candidates from conversations. Turn off to disable automatic proposals. |

## License

[MIT](https://github.com/h-taek/AgentBridge/blob/main/LICENSE) © h-taek
