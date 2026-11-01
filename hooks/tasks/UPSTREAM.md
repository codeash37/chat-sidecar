# Upstream: human-in-the-loop

The mod was called `chat-pane` until 2026-10-27; every `chat-pane` below now reads `chat-sidecar`.

The task part of chat-sidecar comes from [tzafrir/human-in-the-loop](https://github.com/tzafrir/human-in-the-loop) 0.1.8 by Tzafrir Rehan, MIT (see `LICENSE` in this folder). Copied 2026-10-22.

| Here | Upstream |
| --- | --- |
| `register.tsx` | `hooks/register.tsx` |
| `project.ts`, `text.ts` | `hooks/` (unchanged apart from the header and the `../../types` import) |
| `tasks.ts` | `hooks/tasks.ts` (texts: the label `(Tasks for me)`, where the user sees tasks) |
| `pane.ts` | `hooks/pane.ts` (trimmed by change 7: no row sizing, no hotkeys, `answeredOf` added) |
| `tasks.test.tsx` | `tests/register.test.tsx` |
| `types/index.d.ts` (chat-sidecar) | `types/index.d.ts` (the types; the state under `'chat-sidecar'`) |

Not copied: `tests/live/*.py` (they drive a live terminal), `README.md`, `media/`.

## Changes against 0.1.8

1. `human-in-the-loop` → `chat-sidecar` everywhere: `PLUGIN`, the tool names (`mcp__chat-sidecar__assign_task`, `list_tasks`, `withdraw_task`), the steering text, the eight atoms, `StateValue<'chat-sidecar', 'clients'>`, the prompt section id `chat-sidecar:tasks`. The command `/my-tasks` keeps its name; the pane `my-tasks` and the atom `clients` are gone (change 7).
2. `register` is exported as `registerTasks`; chat-sidecar's `register` calls it last.
3. A plugin has one hooks module and a module takes an event once, so the four hooks chat-sidecar registers too are exported as plain functions it calls inside its own hooks, each in its own try/catch:
   - `session.start` → `tasksOnSessionStart($)` (before `next`; chat-sidecar runs it right after reading its switch, before anything else of its own),
   - `turn.step` → `tasksOnTurnStep(e)` (before `next`),
   - `turn.complete` → `tasksOnTurnComplete($, e)` (after `next`),
   - `ui.render AbovePrompt` → `tasksOnAbovePrompt($, isWorking)` (before `next`).
4. Tests: the rig turns chat-sidecar's pane part off through `~/.claude/mods/switches.json` (`{"chat-sidecar": false}`) and answers `fs.*`, `ui.log`, `session.usage`, `session.messages`, which that part calls even when off.
5. `live.held` is mirrored to a `$.state` atom (`held`) and read back in `tasksOnSessionStart`: chat-sidecar changes its `userConfig` from its settings screen, every change reloads the module, and an empty `held` after a reload would send a held response alone at turn end.
6. (Replaced by 7.) Kept My tasks open as a second tab while chat-sidecar was on.
7. **No My tasks pane (2026-10-27).** The tasks are drawn in chat-sidecar's own pane, in its Tasks for me section:
   - `tasksSection($, els, surface, isFocused, columns)` draws the body: every open task whole (no selection: `selectedId`, `select`, `reselect` and the `#id` buttons are gone), the responses not sent yet, Answered (this session's closed tasks, atom `answeredOpen`) and Elsewhere (atom `elsewhereList`, scanned on its press and on a heartbeat while open, never in a render). No hotkeys: the sidecar takes the keys on any click. Button keys carry the task: `t-<id>-done`, `t-<id>-option-<n>`, `t-<id>-answer`, `t-<id>-reject`, `t-send-<id>`, `t-edit`, `t-cancel`...
   - `show` calls chat-sidecar's `sidecarShowTasks($, isAsked)` (imported: `$` goes only to function declarations); asked, it moves the ring to the open field or the first button. `refresh` only keeps the status line. `tasksBeforeOpen` (the drafts drawn again on a pane that was closed) and `tasksUndrawn(surface)` (a drawing without the section) keep typed answers.
   - Gone with the pane: its render, `rows` and every re-size (`rowsFor`, `rowsWanted`, `fit`, `refit`, `openAt`, seats), `closePane`, the client roster (`clients`, `rostered`, `session.detach`).
   - `registerTasks(on, options, host)` takes `host.isOn()`; off, `assign_task` refuses and `/my-tasks` says why. `/my-tasks` stays as the command that brings Tasks for me up. The texts for Claude and the toasts name Tasks for me.
   - Change 4 is reversed: the rig turns chat-sidecar on and its other sections off (`ONLY_TASKS` options), and mounts the `chat-sidecar` pane.

   - The label "(Human in the loop)" in the messages to Claude (`messageOf`, `digestOf`, `contextOf`) reads "(Tasks for me)", and the context block is named `tasksForMe`.

   Upstream changes to the pane's drawing no longer apply; `tasks.ts`, `project.ts`, `text.ts` and the send logic in `register.tsx` still follow upstream.

## Taking a later upstream version

Diff upstream `hooks/` between 0.1.8 and the new version, apply it here, then redo changes 1-3 on what it touched (a new hook on one of the four shared events becomes a function too). Check the Button keys of both parts for clashes: both press as `{ plugin: 'chat-sidecar', element }` (chat-sidecar's Hide is `pane-hide` for that reason).
