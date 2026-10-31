# chat-sidecar

A side pane for Claude Code that shows what the current chat is doing, what is waiting on you, and what it uses. You also answer the tasks Claude gives you right there.

## Features

- **To-do**: Claude's step list, plus a progress band above the prompt.
- **Tasks for me**: tasks Claude assigns you (a decision, an approval, something only you can do). Each card has its buttons: Done or the options, Answer… with a field, Reject… with a reason. Below them sit responses not sent yet, **Answered** (this session's closed tasks) and **Elsewhere** (open tasks in other folders, read only).
- **Subagents**: a live card per subagent with its current step and history.
- **Background**: watched ports grouped by label (`backend :8090 ● 3h05m  :8091 ○`), a warning when another process holds one, and test runs with progress. Pressing a port shows its process, pid and `localhost` link.
- **Connectors**, **Context files**, **Skills**: what the chat used.
- **Git**: the branch the current one was made from, whether the folder is a worktree, and the main repo.

Every section can be turned off or moved. A section that is off stops its background work.

## Requirements

- Claude Code with mods (function hooks); tested on 2.1.311.
- Windows, macOS or Linux. Background port scanning uses `netstat` (Windows) or `ss` (Linux), so on macOS it shows no ports.
- The fullscreen layout (`"tui": "fullscreen"` in settings) docks the pane beside the chat. In the classic layout it opens inline.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install chat-sidecar --marketplace <owner>/chat-sidecar
```

From a shell: `claude plugin install chat-sidecar --marketplace <owner>/chat-sidecar`.
In the desktop app: **+** next to the prompt → **Plugins** → **Add marketplace** `<owner>/chat-sidecar` → **Add plugin**.

To run from a local clone instead, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, or start Claude Code with `claude --plugin-dir <folder>`.

## Usage

The pane opens by itself at the start of an interactive session. The engine places an unasked pane only on a wide enough terminal (about 110–144 columns); otherwise open it with a command.

| Command | What it does |
| --- | --- |
| `/chat-sidecar` | Show the pane (also after **Hide**). |
| `/chat-sidecar settings` | Open the settings screen. |
| `/my-tasks` | Bring up Tasks for me and move the keyboard to it. |

- **Hide** at the top of the pane hides it in every chat until `/chat-sidecar`.
- While tasks wait, the plan band shows `● N for you`. Pressing it works like `/my-tasks`.
- `"chat-sidecar": false` in `~/.claude/mods/switches.json` turns the mod off. Claude is then told it cannot assign tasks.

### Tools for Claude

The mod gives Claude four tools: `mcp__chat-sidecar__plan` (the to-do list), `assign_task`, `list_tasks` and `withdraw_task`. Claude is told about them in the system prompt. For a steadier habit, add this to `~/.claude/CLAUDE.md`:

```markdown
## Tasks for me
When you need something only I can do (a secret put in place, an action on an account you cannot reach, a decision or an approval that is mine), assign it with `mcp__chat-sidecar__assign_task`, even when you also ask in your reply. At session start and after a compaction, call `mcp__chat-sidecar__list_tasks` (show: open).

## To-do list
For any task with more than one step, keep the list with `mcp__chat-sidecar__plan` and send the full list on every change.
```

## Settings

Press **⚙ Settings** in the pane, or use `/config`. Every change reloads the mod. All settings are global.

| Setting | Default | |
| --- | --- | --- |
| `showTodo` … `showGit` | on | Show a section. Off also stops its background work. |
| `sectionOrder` | `todo, tasks, subagents, background, connectors, files, skills, git` | Order of the sections. |
| `bandColor` | `purple` | Plan band colour: `purple`, `green`, `burgundy`, `navy`, `orange`. |
| `barStyle` | `gradient` | Terminal bar style: `gradient`, `segments`, `line`, `dots`, `pixel`. |
| `ports` | `8090=backend, 8091=backend, 5005=debug, 4200=frontend, 4201=frontend` | Watched ports as `port=label`. The label `debug` gets its own colour. |
| `pollSeconds` / `jobsSeconds` | `10` / `30` | How often ports and test runs are scanned. |
| `testWarnMinutes` / `testErrorMinutes` | `15` / `30` | When a test run's age turns yellow / red. |
| `serverWarnHours` | `8` | When a server's age turns yellow. |

## Privacy

Everything runs locally. The mod reads the chat's own events and runs only these commands:
- `netstat`/`ss` and `tasklist` for ports;
- PowerShell `Get-CimInstance` or `ps` for test runs;
- `git rev-parse`, `git reflog`, `git for-each-ref` and `git rev-list` for the Git section.

Tasks are stored in Claude Code's plugin store on your machine. Nothing is sent anywhere.

## Development

```
claude plugin validate .
claude plugin test .
```

## Credits

- The task system is based on [tzafrir/human-in-the-loop](https://github.com/tzafrir/human-in-the-loop) by Tzafrir Rehan (MIT, see `LICENSE-human-in-the-loop`; changes in `hooks/tasks/UPSTREAM.md`).
- The pane idea was inspired by the **chat-inventory** and **helper-desk** mods by [Ben AI](https://www.benai.co); no code from them is used.
- Connector logos come from [Simple Icons](https://simpleicons.org) (CC0), generated by `tools/gen-logos.mjs`.
- The pixel bar style takes its idea from [claude-deck](https://github.com/nvr0x5/claude-deck) by nvr0x5 (MIT). The code is this mod's own.
- Connector logos are marks of their owners, shown only to identify the service.

## License

[MIT](LICENSE)
