# chat-sidecar 0.5.0: behavior spec

This file is the only description of how chat-sidecar behaves that the 0.5.0 rewrite works from. It describes what the user sees and does and what engine events cause; it does not describe how the old code was arranged.

## How to use this spec

- Write the files listed under "To write" from this spec only. Do not look for older versions of this mod anywhere (other folders, git history, the web).
- The files under "Kept" are already in this folder. Do not change them or their tests; they must pass unchanged. Read them freely: they are the real definition of every contract they expose.
- Where the spec gives exact text (labels, empty states, result strings), use it. Where it describes a look ("a progress bar that shimmers"), choose your own glyphs, colours and constants.
- Items marked "(unverified)" were not confirmed against the running mod; pick the reasonable behavior and note it in a comment.
- Connector logos: generate `hooks/logos.ts` with a small script in `tools/` from the `simple-icons` npm package (CC0). A service with no icon gets a letter badge.

### Kept (do not edit)
`hooks/parse.ts`, `hooks/git.ts`, `hooks/background.ts`, `hooks/barstyle.ts`, `hooks/tasks/*`, their tests (`parse.test.ts`, `git.test.ts`, `barstyle.test.ts`, `tasks/tasks.test.tsx`), `.claude-plugin/plugin.json`, `hooks/hooks.json`, the own types above the marker line in `types/index.d.ts`, README, LICENSE files.

### To write
`hooks/register.tsx` (main module), `hooks/register.test.tsx`, `hooks/helpers.ts`, `hooks/helpers.test.ts`, `hooks/band.ts`, `hooks/connectors.ts`, `hooks/logos.ts` (+ `tools/` script), the types and the `PluginState['chat-sidecar']` block after the marker line in `types/index.d.ts`.

### Done when
`claude plugin validate .` and `claude plugin test .` pass, the kept tests pass unchanged, and every item of every "Acceptance" list below has a test.

## Interfaces that must stay exactly as they are (own modules and their tests depend on them)

- `band.ts` exports: `mix(a, b, t)` (used by `barstyle.ts`), `BAND_COLOR_IDS` and type `BandColor` (used by `parse.ts`; `parse.test.ts` pins `purple` as the default).
- `helpers.ts` exports `barParts(phase, w, tick, seat): [before, piece, after]`: the three strings together are exactly `w` cells of `░`/`█`; when `phase` is not `'working'` the result is `['', '█'.repeat(w), '']` (pinned by `barstyle.test.ts:56-62`).
- Types kept above the marker in `types/index.d.ts` (Z1, not rewritten): `GitInfo`, `Listener`, `HelperPhase` (`'working' | 'done' | 'failed'`, used by `barstyle.ts`), `TaskKind` … `Editing`.
- `background.ts`: `poll($, cfg, windows, prev)` returning `Listener[] | null`; `git.ts`: `readGit($)`; `parse.ts`: `Settings`, `SectionId`, `settings()`, `parsePorts`, `level`, `ago`, `DEFAULT_ORDER`, `DEFAULT_PORTS`, `SECTION_IDS`, `SHOW_FIELD`.
- `tasks/register.tsx` exports `registerTasks(on, options, { isOn })` and `tasksBeforeOpen`, `tasksOnAbovePrompt`, `tasksOnSessionStart`, `tasksOnTurnComplete`, `tasksOnTurnStep`, `tasksSection`, `tasksShow`, `tasksUndrawn`, which the main module calls; `tasks/tasks.ts` exports `isShown`.
- Reverse import: `tasks/register.tsx` imports `sidecarShowTasks($, isAsked): Promise<boolean>` from `../register`. Behavior (pinned by `tasks.test.tsx:640-657`): clears hidden only when asked, closes the settings screen, unfolds the tasks section, opens the pane with focus.
- `PluginState['chat-sidecar']` keys used by the tasks atoms: `tasks, nextId, took, editing, loadedFor, isWorking, held, elsewhere, elsewhereList, answeredOpen`. Other keys may change.
- Host contract pinned by the rig in `tasks.test.tsx:175-378`: pane id `chat-sidecar`; `switches.json` keys `chat-sidecar` and `chat-sidecar:hidden` read via `$.fs.exists` / `$.fs.read`; press element `pane-hide`; with only the tasks part active, the main module calls nothing the rig does not provide. The rig is not edited.
- Public contract: `plugin.json` `userConfig` keys and defaults, commands `/chat-sidecar` (+ `settings`) and `/my-tasks`, tools `mcp__chat-sidecar__plan|assign_task|list_tasks|withdraw_task`, `$.store` keys (tasks survive the upgrade), the `switches.json` off switch.


---

# Part 1: pane frame, settings, plan band, To-do

Scope: the side pane's frame and lifecycle, the settings screen, the off/hidden switches, the plan band above the
prompt, the To-do section and the `mcp__chat-sidecar__plan` tool. The content of other sections (Tasks for me cards,
Subagents, Background, Connectors, Context files, Skills, Git) is out of scope except where the frame depends on it.

### 1. Where state lives

| Where | Scope | What |
|---|---|---|
| `$.state` (engine-held, per session, survives a hot reload of the module) | this chat | the plan; whether the band is shown; folded sections; settings screen (open, ports error, ports draft); "already auto-opened"; "history seeded for session id X"; the off mirror; other sections' lists |
| `~/.claude/mods/switches.json` | global, all chats | `"chat-sidecar": false` (off), `"chat-sidecar:hidden": true` (hidden) |
| plugin `userConfig` (plugin.json, edited in `/config` or the settings screen) | global | `showTodo`, `showTasks`, `showSubagents`, `showBackground`, `showConnectors`, `showFiles`, `showSkills`, `showGit`, `sectionOrder`, `bandColor`, `barStyle`, `ports`, plus Background timing keys (`pollSeconds`, `jobsSeconds`, `testWarnMinutes`, `testErrorMinutes`, `serverWarnHours`) |
| module memory | lost on every reload | timers, last plan stamp seen by the band, hold timer |

- Settings are read once when the module registers. Every settings write (from `/config` or the screen) reloads the
  module, which runs `session.start` again in the same session.
- The "seeded" flag is keyed by session id; the "auto-opened" flag is a plain boolean. Whether `/clear` or a resume in
  the same process resets `$.state` (and so re-opens the pane) is (unverified).
- Errors are never shown to the user; they go to `~/.claude/mods-logs/chat-sidecar.log` (last 200 lines kept).
  Settings values that could not be understood go to the debug log as `config: ...` lines at session start.

### 2. The pane

- Pane id `chat-sidecar`, title `Sidecar`. One pane only; there are **no tabs** today. (PLAN-tabs.md describes a
  two-pane "In this chat" / "My tasks" design; version 0.4.0 removed it. At session start the task part closes a
  leftover pane with id `my-tasks` from older versions.) Because the engine shows a pane title only as a tab, and tabs
  only exist with two or more panes, the pane draws its own title.
- Before any open, the task part is given a chance to prepare its input fields (restore drafts), see section 9.

#### 2.1 Opening by itself
- On `session.start`, if the session is interactive (`isInteractive === true`), the mod is not off, not hidden, and the
  per-session "auto-opened" flag is not set: set the flag, then `$.ui.open({ id: 'chat-sidecar', title: 'Sidecar' })`
  without focus (it must not take the keyboard from the prompt).
- A reload (or a second `session.start` in the same session) never opens it again. A non-interactive run never opens it.
- Width is the engine's rule, not the mod's: an unasked open is seated from 144 terminal columns (110 for an id the
  person opened before and has not closed by hand since); below that the pane is open but undrawn until the terminal
  widens or the person asks. An asked open (a command, a press) is seated at any width (docked beside a fullscreen
  transcript from 110 columns, otherwise inline).
- The off switch is read before the task part starts and before the auto-open.

#### 2.2 `/chat-sidecar` command
- Registered at session start as an immediate command, description "Show the Sidecar pane: to-do, subagents,
  background, connectors, files and skills; settings with \"settings\"".
- Off: replies `Chat sidecar is off: remove "chat-sidecar": false from ~/.claude/mods/switches.json.` and opens nothing.
- Hidden: clears the hidden flag first (section 3).
- Args trimmed and case-insensitive equal to `settings`: sets the settings screen open, opens the pane, replies
  `Opened the chat sidecar settings.`
- Otherwise opens the pane (asked, no focus), refreshes the context-file list from the engine (only when Context files
  or Skills is shown), replies
  `Opened the Sidecar pane.`

#### 2.3 Bringing up Tasks for me (used by `/my-tasks` and the band count)
The task part asks the frame to show Tasks for me, saying whether the person asked:
- off: nothing, reports "not drawn";
- hidden and not asked (e.g. a task was just assigned): stays hidden, reports "not drawn";
- hidden and asked: clears the hidden flag;
- then closes the settings screen if open, unfolds the Tasks for me section, opens the pane, with focus only when asked.
  Reports whether the engine placed it.

### 3. Hide and the off switch

#### Hide
- Top-row button **Hide** (element id `pane-hide`; the task part's own ids must not collide).
- Press: read `switches.json` (missing = `{}`), set `"chat-sidecar:hidden": true`, write the whole file back
  (2-space JSON plus newline), close the pane, show toast `Chat sidecar hidden. Type /chat-sidecar to show it again.`
- Undo: `/chat-sidecar`, `/my-tasks`, or pressing `● N for you` on the band. Each removes the key (other keys kept) and
  opens the pane.
- Every session polls `switches.json` every 3 s. When the hidden flag appears, that session closes its pane too, so
  Hide applies to every open chat within about 3 s. A missing file means on and shown. Unreadable or invalid JSON keeps
  the last known state. If Hide meets an existing but invalid file, the flag is not written (logged), yet this session
  still closes its pane and treats itself as hidden until the next successful read.
- While hidden: no auto-open; the plan part of the band is not drawn (the `● N for you` count still is); the shimmer
  clock stops; a newly assigned task does not open the pane. Data collection continues, so the pane is current when shown.

#### Off: `"chat-sidecar": false`
- Picked up at start and by the 3 s poll; turning back on is also picked up within 3 s and triggers a redraw.
- While off:
  - the pane is not closed, but draws only one dim line: `Turned off in ~/.claude/mods/switches.json ("chat-sidecar": false).`;
  - no auto-open; `/chat-sidecar` replies with the off text; `/my-tasks` replies with its own off text and the task
    tools refuse (task part);
  - tool calls, slash-command skills and subagents are not recorded; the Background list and the Git facts are cleared
    and their scans stop;
  - the band draws nothing of its own (it passes the hook through: no plan, no count);
  - the plan tool answers `The chat sidecar is off, so the plan is not shown.` and saves nothing.

### 4. Frame layout

- Width = max(20, `bodyColumns`); inner width = width − 4 (round border plus 1 column padding each side).
- **Top row**: the title `Sidecar` (bold, accent colour, element key `title`), filling the row; then the button
  `⚙ Settings` (id `pane-settings`) and `Hide` (id `pane-hide`), both dim.
- Then the sections in the configured order (section 5). If none is visible: dim wrapped line
  `All sections are off. Open ⚙ Settings to turn one on.` (the Settings button stays).
- **Section frame**: a round-bordered column (frame element keyed by the section id), padding 1 column, full width, never shrunk.
  - Header row, full inner width: on the left a pressable header (id `sec-<sectionId>`) with `▾ ` when open or `▸ `
    when folded (arrow in accent colour), then the bold title. On the right the count text, dim, and an optional extra
    control from the section.
  - A section that waits on the person (Tasks for me with open tasks) paints its arrow, title, count (bold) and border
    in the `warning` colour.
  - Folded: only the header row is drawn.
- Long content lists capped at 40 rows with a dim `+N more` line (a frame helper, used by content lists).
- **Titles and counts on the right**:

| id | Title | Right side |
|---|---|---|
| `todo` | To-do | `<done> of <total>`; empty when there is no plan |
| `tasks` | Tasks for me | number of open tasks; empty when none (warning colour when > 0) |
| `subagents` | Subagents | `<running> running of <all>`; empty when none |
| `background` | Background | `<up> of <all> up` plus ` · <n> ⚠` if ports are held by other processes; else number of test runs; else empty |
| `connectors` | Connectors | number of connectors (also `0`) |
| `files` | Context files | number of files (also `0`) |
| `skills` | Skills | number of skills (also `0`) |
| `git` | Git | current branch name |

#### Folding
- Every section, Tasks for me included, folds by pressing its header. A press toggles only that section.
- Folded sections are kept per chat in `$.state` (survive reload, not a new session). All open by default.
- Bringing up Tasks for me (2.3) always unfolds it.

### 5. Section order and show/hide

- `sectionOrder`: ids separated by commas, semicolons or spaces, case-insensitive. Unknown ids and repeats are skipped
  (logged), missing ids are appended in default order: `todo, tasks, subagents, background, connectors, files, skills, git`.
- `show<Name>` false: the section is not drawn **and its background work stops**:
  - Background: no scan timer starts, its list is cleared;
  - Git: git never runs, facts cleared;
  - Subagents: no live tick (300 ms) or status poll (2 s) timers (spawns are still noted);
  - Context files and Skills: the memory-file load at start and on `/chat-sidecar` is skipped only when both are off;
  - To-do: the band's plan is not drawn and its shimmer stops, but the plan tool still answers "Plan saved" and keeps
    the plan.
- Exceptions to visibility: Tasks for me is drawn, even when `showTasks` is false, whenever any task is shown, so a
  waiting task is never out of sight. Git is drawn only inside a git repo.

### 6. Settings screen (⚙ Settings)

Opens on `pane-settings` or `/chat-sidecar settings`; replaces the whole pane body (top row included) until closed. Its
open/closed state, ports error and ports draft live in `$.state`, so they survive the reload each write causes. The off
line wins over the screen.

Writes go through `$.config.list()` / `$.config.set()`: the mod finds its own rows (keys starting with `chat-sidecar.`
or `chat-sidecar@`, field name = part after the last `.`). A row that is locked, missing, or already equal to the new
value is not written. A refusal from the engine is logged. A **locked** row is drawn without buttons plus
`(set by your organisation)`.

Four round-bordered boxes, full width, then a button row:

1. **Sections** (bold heading). One row per section in current order: on the left a toggle (id `set-show-<id>`) showing
   `[x] ` (accent) or `[ ] ` then the section title; on the right `▲` (id `set-up-<id>`) and `▼` (id `set-down-<id>`).
   The first row has no up button, the last no down button (drawn dim, not pressable); if `sectionOrder` is locked all
   arrows are dim. Locked show field: dim `[x] To-do (set by your organisation)`. Toggle writes the inverted
   `show<Name>`. Up/down swaps with the neighbour and writes the whole order as `id, id, ...`. Dim hint below:
   `Off, a section is not drawn and its background work stops.`
2. **Plan band colour**: a wrapping row of the five colours, each `◉ Name` (chosen, bold) or `○ Name`, drawn in that
   palette's middle tone. Pressing one (id `set-color-<colorId>`) writes `bandColor`. The chosen one, and all when
   locked, are not buttons.
3. **Bar style**: dim note `The terminal's plan band and subagent bars.`, then one row per style: `◉`/`○`, the style name
   padded to 9 characters, and a 10-cell preview of the style (3 of 5 steps done, the 4th in progress, in the chosen band
   colour). Pressing (id `set-bar-<styleId>`) writes `barStyle`; chosen / locked are not buttons.
4. **Background ports**: an input (id `set-ports`, label `Ports `, placeholder `8090=backend, 4200=frontend`, submit label
   `save`) holding the draft if any, else the `ports` option as the module received it, or the default list when the
   module received no value. (`/config` lists an unset field as empty while the module gets no value for it; a saved
   empty string is a real value meaning "watch nothing" and shows as empty.)
   On mobile, or without an input element, or when locked: a dim text with the value (or `none`) and
   ` (edit in /config)` or ` (set by your organisation)`.
   On Enter: entries split by commas, semicolons or spaces; each must be `port=label` with port 1 to 65535. Any bad
   entry: red line `Not understood: <bad entries> (expected port=label)`, nothing written, the typed text stays in the
   field to fix. All good: writes the trimmed text to `ports`. Without an error the dim hint
   `port=label, separated by commas; Enter saves.` shows.
5. Buttons: **Done** (id `set-done`) closes the screen and clears error and draft. **Reset to defaults** (id
   `set-reset`, dim) clears error and draft, then writes every show field true, the default order, the default ports,
   `bandColor` `purple`, `barStyle` `gradient`, skipping locked and unchanged fields (so only differing fields are
   written). The screen stays open.

Invalid stored values fall back silently in drawing (logged): unknown `bandColor` → `purple`, unknown `barStyle` →
`gradient`.

### 7. Plan band above the prompt (`ui.render { component: 'AbovePrompt' }`)

#### When it draws
- Always pass the "is working" flag to the task part first.
- Off, or `hasSurvey` set: return what the hook beneath returns, nothing added.
- Plan part shown when: not hidden, `showTodo` on, the band's "shown" flag is set, and the plan has at least one step.
- Count part shown when at least one task is open (independent of hidden, no plan needed).
- Neither: pass through. Otherwise call the hook beneath first and draw its result (other mods' bands) above this band,
  unless that result is the engine's own placeholder, which is dropped.

#### The "shown" flag
Recomputed whenever the plan's stamp changes:
- no steps: hide;
- every step completed and the previous plan was not all done: show, then hide after **20 s**;
- not all done: show and cancel any pending 20 s hide;
- all done again when it was already all done: no change.
- **✕** (id `plan-dismiss`, dim, plain): hides the band and cancels the 20 s timer; the next plan change shows it again per the rules above (not a change that leaves an already all-done plan all done).
- After a reload in the same session: a fully done plan's band is hidden (its 20 s timer died); otherwise the stored flag
  stands (a dismissed band stays dismissed).

#### Count only (no plan part)
A row with the bold `warning` button `● N for you` (id `band-tasks`).

#### With a plan
Title = plan title or `Plan`. Count `Tasks <done>/<total>`, percent rounded `<p>%`. Columns `w` = `bodyColumns`, or 30
when not given.
- **Desktop, editor, mobile** (any surface not `terminal` that has an SVG element): one row: a drawing of the band
  (height 24 px; width about 8 px per column, 100 columns assumed when `bodyColumns` is absent, minus room for the count button and ✕, clamped 180 to 1600 px) in the
  chosen palette: dot, title, a rounded track filled by done/total with a gradient light → mid → deep, ticks between
  steps, a soft pulse over the in-progress step, a `Tasks d/n` pill at the fill head, percent at the right; motion off
  with reduced motion. Its alt text is `<title>: Tasks <d>/<n>, <p>%`. Then `● N for you` if any, then ✕.
- **Terminal**: one row `w` wide: a dot in the palette's deep tone; the bold title in a box 6 to 28 columns (no more
  than w/3 and the title length), cut with `…`; the bar (cells from the shared bar-style code for `barStyle`, given
  done, total, whether a step is in progress, the bar width, the shimmer tick and the palette's light/mid/deep); the count
  bold in the mid tone; percent dim; `● N for you`; ✕. Bar width = w − title box − count − percent − 10 − (count
  button width), at least 6.
- Second line, dim, cut to `w`: `Now: <active form or text of the in-progress step>`, else `All steps done` when all are
  done, else `Next: <first pending step>`.
- Shimmer: a 350 ms tick runs only while the plan part is shown and a step is in progress (and not off, not hidden,
  `showTodo` on); it stops otherwise. The 3 s switch poll re-checks it.

#### Pressing `● N for you`
Same as `/my-tasks`: an asked "bring up Tasks for me" (2.3): unhides if hidden, closes the settings screen, unfolds
Tasks for me, opens the pane with focus.

#### Colour and bar contract (public values)
- `bandColor` ids and names: `purple` Purple, `green` Bottle green, `burgundy` Burgundy, `navy` Navy, `orange` Orange.
  Each palette has a light, mid and deep tone plus a light-mode and dark-mode track and tick tone. Default `purple`.
- `barStyle` ids and names: `gradient` Gradient, `segments` Segments, `line` Line, `dots` Dots, `pixel` Pixel. Default
  `gradient`. The style code is the mod's own and stays; the frame only asks it for the band cells (terminal band,
  settings previews, Background test runs, all in the band palette) and for the subagent card bars.
- `mix(a, b, t)`: a colour between two `#rrggbb` colours, `t` from 0 to 1, each channel rounded, result `#rrggbb`
  lower-case hex. The bar-style code uses it for shading.

### 8. To-do section and the plan

#### One plan per chat
A title, ordered steps (text, status `pending` | `in_progress` | `completed`, optional active form, optional id), and
an update stamp. Every change raises the stamp strictly above the old one. Only main-chat calls count (calls with an
`agentId` are ignored). Built-in tools count only when the call was not denied. Sources:

- **`mcp__chat-sidecar__plan`** (main source; these sessions usually have no TodoWrite/TaskCreate). Registered at
  session start as `plan`, not deferred (always in the prompt). Description: "Save the plan for the job in front of
  you: the steps in order, each pending, in_progress or completed. It draws the to-do list and a progress bar above the
  prompt for the user. Send the whole list on every change. Main chat only: a subagent does not call it."
  Input: `title` (string, optional, "A short name for the job, a few words."), `steps` (required array of
  `{ text: string, status: 'pending'|'in_progress'|'completed' }`, both required). Replaces all steps; replaces the
  title when `title` is given (trimmed), keeps the old one otherwise. The mod answers the call itself (nothing beneath
  runs) and never counts it as a connector. Results:
  - saved: `Plan saved. Send the whole list again on every change.`
  - from a subagent: `Only the main chat keeps a plan. Carry on with your task.` (plan unchanged)
  - off: `The chat sidecar is off, so the plan is not shown.`
  - internal error: `Plan not saved: something went wrong in the chat sidecar.`
- **TodoWrite**: `todos[]` with `content`, `status`, `activeForm`; replaces all steps, keeps the title.
- **TaskCreate**: `subject` (required, else ignored), `activeForm`; appends a pending step whose id is the created task's
  id from the call result, or its 1-based position.
- **TaskUpdate**: `taskId` (string or number) finds the step by id; if no step has an id, a numeric id is a 1-based
  position. Unknown: ignored. `status: 'deleted'` removes the step; otherwise `subject`, `activeForm` and `status`
  replace what they give.
- Steps without text are skipped; an unknown status counts as `pending`.
- Whichever source changed the plan last wins; there is no merge between sources. The shared file
  `~/.claude/mods-state/plan-<session>.json` mentioned in the old PLAN.md is **not** read or written.

#### Seeding from history
- On `session.start`, if the stored "seeded for" session id differs from the current one: replay every plan-tool call
  of the main chat history, oldest first (TaskCreate ids then fall back to positions), and keep the result only if the
  stored plan is not newer; then record the session id. Then compute the band (section 7).
- Same session id (a reload): no replay; the band state is restored as in section 7.

#### Drawing the section
- Header: `To-do`, right side `<done> of <total>`.
- No steps: a dim line, wrapped to the inner width:
  `No to-do list yet. Claude makes one for any task with 1 or more steps.` and no count.
- Otherwise: the title (if any) as dim wrapped lines, then one row per step: a 2-column mark column (`✓` green when
  completed, `●` accent when in progress, `○` dim when pending) and the text wrapped beside it at inner width − 2
  (breaks at spaces, words longer than the line are hard-split, minimum line width 8). In progress: the active form if
  given, bold. Completed: dim and struck through. No cap on rows.

### 9. Contracts with the task part (frame side only)
- The frame tells the task part when a surface drew the pane without the Tasks for me body (off line, settings screen,
  section folded or not visible), so its input fields restart with their saved drafts next time.
- `/my-tasks` (registered by the task part) and the band count both go through 2.3.

### Acceptance

1. Given an interactive session start, when it settles, then the pane `chat-sidecar` is opened exactly once; given a
   later `session.start` with source reload in the same session, then it is not opened again; given a non-interactive
   start, then nothing opens.
2. Given only the sidecar at start, when tasks are assigned, then no pane other than `chat-sidecar` is ever opened, and
   the pane's top row shows the title `Sidecar`.
3. Given `"chat-sidecar": false` in switches.json, when the session starts and a connector call happens, then no pane
   opens, `/chat-sidecar` replies with text containing `Chat sidecar is off`, and the pane draws only the `Turned off`
   line with no section titles.
4. Given the pane is shown, when Hide is pressed, then switches.json holds exactly `{"chat-sidecar:hidden": true}`, the
   pane is opened-then-closed, and later activity does not open it again.
5. Given the hidden flag at start, when the session runs, then the pane does not open; when `/chat-sidecar` runs, then
   the flag is removed from the file and the pane opens.
6. Given the pane was hidden with Hide, when `/chat-sidecar` runs, then only the sidecar pane opens; hidden again, when
   `/my-tasks` runs, then the sidecar opens again.
7. Given files and skills were used, when the pane is drawn, then each section header starts with `▾ `; when the
   Context files header is pressed, then it reads `▸ Context files`, its rows disappear and other sections keep theirs;
   pressing again shows them.
8. Given a TodoWrite with one completed, one in-progress and one pending step, when the pane is drawn, then there is a
   `To-do` heading, `1 of 3` on the right, one `✓`, one `●`, one `○`; the done text is dim and struck through; the
   in-progress row shows the active form in bold; the empty-plan line is absent.
9. Given the plan tool is called with a title and two steps, then the result contains `Plan saved`; given the same tool
   from a subagent, then the result contains `Only the main chat` and the plan does not change; after a second main
   update the count shows `1 of 2` and no `chat-sidecar` connector appears.
10. Given a plan step longer than the pane, when drawn at 48 columns, then it wraps onto several lines, each at most 42
    characters, and the title and counts still show.
11. Given no plan, when the pane is drawn, then a dim line starting `No to-do list yet.` shows and no `N of M` count.
12. Given a plan with 2 of 4 done and step 3 in progress, when the band is drawn (60 columns), then it says `Tasks 2/4`
    and `50%` (desktop: in the drawing's alt text) and, in the terminal, a line `Now: <active form of step 3>`.
13. Given that plan then fully completed, then the band still shows `Tasks 4/4`; 20 s later it shows nothing of its own.
14. Given a new unfinished plan, then the band shows again (`Tasks 0/2`); when ✕ is pressed it shows nothing; when the
    plan changes again it shows `Tasks 1/2`.
15. Given the hidden flag at start and a plan, when the band is drawn, then it shows nothing of its own.
16. Given `barStyle: dots` and a 4-step plan with 2 done and 1 in progress, when the terminal band is drawn, then its
    bar is the dots style (one dot per step, the in-progress dot distinct, the pending one hollow).
17. Given no plan and no open tasks, then the band has no `band-tasks` element; given two open tasks, then it shows
    `● 2 for you` alone; with a plan added, both the plan and the count; with the hidden flag set (after the 3 s poll),
    the count stays; when the count is pressed, then the sidecar pane opens.
18. Given `showTasks` and `showTodo` false, when the pane is drawn with no tasks, then there is no Tasks for me section;
    when a task is assigned, then the section appears with its answer buttons, and the plan tool still answers without
    saying it is off.
19. Given Background, Subagents and Context files off, when a subagent runs and 30 s pass, then no port scan and no
    agent-list poll happen; the pane draws To-do but not those three sections, and an always-loaded skill from a
    memory file still shows under Skills.
20. Given `sectionOrder: "skills, todo"`, then section headers are drawn skills, todo, tasks, then the rest in default order.
21. Given every `show*` false, then the pane shows `All sections are off` and still has the `pane-settings` button.
22. Given the settings screen opened with `pane-settings`, then `Sections` shows and the first row has no up button;
    toggling Background writes `chat-sidecar.showBackground = false`; moving To-do down writes
    `chat-sidecar.sectionOrder = "tasks, todo, subagents, background, connectors, files, skills, git"`.
23. Given purple chosen, then purple is not a button; pressing navy writes `bandColor = navy`. Given gradient chosen,
    then gradient is not a button, each style shows its name with a preview, and pressing dots writes `barStyle = dots`.
24. Given only `showSkills` differs from the defaults, when Reset is pressed, then exactly one write happens:
    `showSkills = true`. When Done is pressed, then the screen is gone.
25. Given `/chat-sidecar settings`, then the pane opens on the settings screen; a locked `showTodo` has no toggle and
    reads `To-do (set by your organisation)`; with `ports` empty in `/config` the field shows the default port list.
26. Given `9000=api, oops` is submitted in the ports field, then `Not understood: oops` shows, nothing is written and the
    field keeps the typed text; given `9000=api` is submitted, then `chat-sidecar.ports = "9000=api"` is written.

---

# Part 2: Subagents, Connectors, Context files, Skills

Scope: four content sections of the Sidecar pane (pane id `chat-sidecar`) and how they are fed by engine events and seeded from chat history. Pane frame, section headers/folding (`sec-<id>` presses), settings, Hide, the plan band, To-do, Tasks for me, Background and Git are other parts of the spec.

General rules for all four sections:
- When the mod is switched off (`switches.json` `"chat-sidecar": false`), nothing is tracked or counted; tool calls pass through untouched.
- Tracking happens whether or not a section is shown in the settings; turning a section off only hides it (and, for Subagents, stops its animation timers; see 1.9).
- Section header titles: `Subagents`, `Connectors`, `Context files`, `Skills`. Header right-hand text: Subagents `R running of T` (empty when there are no cards); Connectors, Context files, Skills: the number of rows (connectors / files / skills).
- Empty state for Connectors, Context files, Skills: one dim line `None used yet`. Subagents: one dim line `None yet. Cards show up when Claude starts a subagent.`
- Long lists in Connectors call lists and Skills are drawn at most 40 rows, followed by a dim `+N more` line.
- `$.state` (session-scoped, survives a hot module reload, empty in a new process) holds: the inventory (connectors, files, skills), the session id that was already seeded, which connector call list is open, the first visible Context files row, the subagent cards, the subagent view state (expanded cards, folded groups), and an animation clock. Module variables (dedup set of tool-use ids, per-server connector names learned from tool names, unknown agent ids, skill-name cache) reset on a reload. No `$.state` key of this part is read by the tasks module.

---

### 1. Subagents

#### 1.1 Card lifecycle (engine events)

A card has: id (the agent id), description, type, model (display form), effort, phase (`working` / `done` / `failed`), start and end clock time, total tool-call count, kept steps, token totals (finished turns + current turn), whether any usage was ever seen, a seat number and a colour.

- `agent.spawn`: after the spawn runs, if the result carries an `agentId`, a card is created: description = spawn `description` or `Subagent`; type = `subagentType` or `subagent`; model = short name (1.7) of the spawn's `model`, else the result's `model`, else empty. Phase `working`, start = now, colour picked (1.5), seat = next seat number (0, 1, 2, ... per module, continued after reload). If a card with that id already exists (it was adopted earlier from its own calls), the spawn only fills in description and type (when given) and the model (only if the card has none).
- `tool.call` carrying `agentId`: BEFORE the call runs (so the live line shows it immediately), the call is turned into a step (1.2) and appended to that card; the call count goes up by one. A card in `done`/`failed` that makes a new call goes back to `working` (end time cleared): a teammate picking up work again. The step is recorded even if the call is later denied.
- `turn.step` carrying `agentId` (one model request): after it runs, sets the card's model (short name of the step's `model`, if non-empty) and effort (the step's `effort` as text, if present); if the result has usage, adds its total to the current-turn token count and marks usage seen.
- `turn.complete` carrying `agentId` of a known card: after it runs, the card is over: `failed` if reason is `error` or `refusal` or the turn was aborted, else `done`; end = now. Tokens: if the event has usage, its total is added to the card total (the turn's own sum wins over the per-step sum); otherwise the per-step sum of this turn is added. Current-turn count resets to 0.
- Usage total = input + output + cache-read input + cache-creation input tokens.
- Adoption of missed loops: a `tool.call` or `turn.step` with an unknown `agentId` looks it up in `$.agent.list()`. Found: a card is created from its description and type (model empty), then the event is applied. Not found (the engine's own forks): the id is remembered as foreign for the life of the module and ignored from then on.
- Poll: every 2 s while at least one card is `working`, `$.agent.list()` is read. For each working card: list status `completed` or `idle` -> `done`; `failed` or `killed` -> `failed` (end = now). The poll only ever moves cards out of `working`. It also fills an empty description from the list.
- Subagent cards are NOT seeded from chat history; they come only from live events and from `$.state` after a reload.

#### 1.2 Tool call -> step

Each step has a kind, a short label, optional dim text (a folder), and a "live" sentence. Paths are normalised to forward slashes first. "Home shortening": a folder/path starting with the home folder is shown as `~` + the rest. File name = last path segment.

| Tool | Kind | Label | Dim | Live text |
|---|---|---|---|---|
| `Read` (`file_path`) | File read | file name, or `a file` | containing folder, home-shortened | `Reading <name>` |
| `Write` | File write | file name | folder | `Writing <name>` |
| `Edit`, `MultiEdit` | File write | file name | folder | `Editing <name>` |
| `NotebookEdit` (`notebook_path`) | File write | file name | folder | `Editing <name>` |
| `Grep`, `Glob` | File read | `Search "<pattern cut to 60>"` or `Search files` | `path` arg, home-shortened | `Searching files for "<pattern cut to 40>"` or `Searching files` |
| `Bash` | Command | `description`, else `command` cut to 80, else `a command` | - | `Running: <label>` |
| `WebSearch` | Web | `query` or `web search` | - | `Searching the web: <query>` |
| `WebFetch` | Web | host of `url`, or `a web page` if not a URL | - | `Opening <host>` |
| `Skill` | Skill | skill name or `a skill` | - | `Using the <name> skill` |
| `Agent`, `Task` | Subagent | `description` or `Start a subagent` | - | `Starting a subagent: <description>` or `Starting a subagent` |
| `SendMessage` | Subagent | `Send a message` | - | `Sending a message` |
| `TodoWrite` | Tool | `Update its to-do list` | - | `Updating its to-do list` |
| `ToolSearch` | Tool | `Load tools` | - | `Loading tools` |
| any `mcp__...` | Connector | `<Connector name> · <words>` | - | `<Connector name>: <words>` |
| anything else | Tool | the tool name | - | `Using <tool>` |

String arguments are flattened to one line (whitespace collapsed). "Cut to n" = at most n characters, ending in `…` when shortened. Connector name: section 2.2. Connector "words": the tool part of the MCP name (double underscores read as single), camelCase split into words, split on `-`/`_`/spaces, lower-cased, joined with spaces; if there is more than one word and the first equals the first word of the connector name (case-insensitive), it is dropped (`slack_search_public` from Slack -> `search public`).

Each kind has its own fixed tag colour (8 distinct colours; the File write colour is the mod's accent).

#### 1.3 What a card shows

Rounded border; while working the border is in the card colour, when over it is dim. Inner width = section inner width minus 4.
1. Description in bold (truncated to fit), and at the right a mark: `●` while working, `✓` done, `✗` failed (green for running/done, red for failed).
2. Dim line: `type · model · effort` (empty parts skipped), truncated; right-aligned: `<tokens> tokens · <elapsed>` (tokens only once usage was seen; tokens = finished-turn total + current turn). Elapsed: while working, now - start (never negative); when over, end - start.
3. Lead line:
   - working: an animated spinner glyph (4 frames, accent colour), then bold accent `Step <count> · <live text of the newest step>` (or `Getting started` when no steps), then a small animated 3-dot pulse.
   - done: green `Done · N step(s)`.
   - failed: red `Stopped before it finished · N step(s)`.
   (`step`/`steps` by count; N is the total call count.)
4. Collapsed only: up to 3 recent steps as dim, indented live-text lines; while working these are the 3 steps before the newest one, when over the last 3 steps.
5. The progress bar (1.6), one row, card inner width; the moving/full piece in the card colour (red when failed), the rest dim.
6. If the card has any steps: a plain dim toggle button, `▸ All N step(s)` when collapsed, `▾ Hide steps` when expanded. Press element `steps-<agentId>` toggles it. Expanded state is kept in `$.state` per agent id.
7. Expanded: if more calls happened than steps kept, a dim `<k> older steps not kept` line; then every kept step, oldest first, as a row: an 11-cell column with the kind name in its kind colour, then the label and, in dim, the folder. Fitting rule: label first; if the label alone fills the row, it is cut and no folder is shown; otherwise the folder gets the remaining width minus 2; if fewer than 4 cells remain the folder is dropped; a folder too long is shown with its left end replaced by `…` (keep the tail).

Card element key `card-<agentId>`.

#### 1.4 Grouping and folding

Cards are drawn in three groups, in this order, each only if non-empty, cards in creation order inside each:
- `Running` (working): heading on a filled blue background, white bold text.
- `Finished` (done): plain bold heading, no background.
- `Stopped` (failed): bold red text, no background.
Heading text `<Title> · <n>` padded to the row, preceded by a fold arrow (`▾` open, `▸` folded). Pressing the arrow (element `group-<running|finished|stopped>`) folds/unfolds that group; folded groups show no cards. Folded state kept in `$.state`. Heading element keys `head-<group>`.

#### 1.5 Colours

8 card colours in a fixed order (red, orange, yellow, green, teal, blue, purple, pink). A new card takes the next colour in order after the last one handed out, skipping any colour worn by a currently running card; if all 8 are worn by running cards, it just takes the next in order. So running cards never share a colour while there are at most 8. After a reload the order continues after the highest colour index among restored cards.

#### 1.6 Bar contracts (`barstyle.ts` exports, kept as public contracts)

`barParts(phase, w, tick, seat) -> [before, piece, after]`:
- Total length of the three strings is always exactly `w`.
- `phase` not `'working'`: `['', '█' repeated w, '']`.
- `'working'`: piece length p = max(3, floor(w/4)). Head position h = ((tick + 5*seat + p) mod (w + p)) - p, so the piece slides left to right and re-enters from the left; the visible piece covers cells from max(0, h) to min(w, h + p). `before` = `░` for the cells before the piece, `piece` = `█` for the visible cells (may be empty at the wrap point), `after` = `░` for the rest. `seat` offsets each card's phase so cards do not move in lockstep.

`agentParts(style, phase, w, tick, seat) -> [before, piece, after]`: calls `barParts` and restyles it, keeping each part's length. `gradient` returns it unchanged. Other styles (`segments`, `line`, `dots`, `pixel`) replace the track parts with the style's dim track glyph and the piece with the style's filled glyph (segments: filled/empty parallelograms; line: heavy line on a light line; dots: big dots on a middle-dot track; pixel: dense braille cells that twinkle with the tick, on a dim braille baseline). Done/failed: a full bar of the style's filled glyph. The style is the `barStyle` setting.

#### 1.7 Formatting

- Elapsed: `m:ss` under an hour (`0:00`, `1:05`), `h:mm:ss` from an hour (`1:02:05`); whole seconds, floored, never negative.
- Tokens: below 1000 the exact number; below 1,000,000 rounded thousands + `k` (`34k`); else millions with one decimal + `M` (`1.2M`).
- Model short name: find a family word `opus`, `sonnet`, `haiku` or `fable` (any case) optionally followed by a major number and a minor number (separated by `-`, `_`, space or `.`). Result: family capitalised, plus ` <major>` and `.<minor>` when present (`claude-opus-5-5` -> `Opus 5.5`, `haiku` -> `Haiku`). No family found: the input unchanged (`gpt-x` -> `gpt-x`).

#### 1.8 Limits

- Steps kept per card: the newest 200; older ones are only counted (call count keeps growing).
- Finished cards kept: at most 30 cards that are done or failed; past that the oldest ones (creation order) are dropped. Running cards are never dropped.
- Collapsed history: 3 lines.

#### 1.9 Timers and reload

- While at least one card is working, the mod is on and the Subagents section is shown: an animation tick every 300 ms (advances spinner, pulse, bar, elapsed time) and the 2 s poll. Otherwise both stop. Card tracking (spawn, steps, turn complete) continues with the section hidden, so a card never hangs as running.
- Every card change writes the whole card list to `$.state` (`helpers`) and updates the clock value.
- Module reload in the same session: on `session.start`, if the module has no cards, it restores them from `$.state`, continues seat numbering and colour order, and restarts the timers if any card is working. Expanded/folded state also survives. Unknown-agent memory does not survive (an id may be looked up again).
- New process/session: no cards.

---

### 2. Connectors

#### 2.1 What counts as a connector use

Counted after the call runs and only if it was not denied; each `tool_use_id` is counted once per module (so a call seen in seeding is not counted again live). Calls from the main chat and from subagents both count.

1. MCP tool: name `mcp__<server>__<tool>` (server = part between the first and second `__`, tool = everything after, may itself contain `__`). Excluded: empty server, servers starting with `ccd_`, and this mod's own tools (`mcp__chat-sidecar__...`, e.g. `plan`, `assign_task`).
2. Bash CLI: in a Bash `command`, each occurrence of one of the command words `gws`, `firecrawl`, `youtube-pp-cli`, `browser-harness`, `agent-browser` in command position: at line start, or after `;`, `&`, `|`, `(`, newline, backtick, `do`, `then`, `$(`, optionally preceded by `VAR=value` assignments, and as a whole word (`gwsx` or `ls ~/gws` do not count). Its arguments run until the next `;`, `&`, `|`, newline, backtick or `)`. One Bash line can yield several calls; identical (name, call text, summary) triples within one line count once.
   - `gws <service> ...`: service `gmail` -> Gmail, `calendar` -> Google Calendar, `drive` -> Google Drive, `sheets` -> Google Sheets, `docs` -> Google Docs, anything else -> Google Workspace. Call text: up to 3 following plain lower-case-starting words (after the service when it is a known one), else the service word, else `run`.
   - `firecrawl` -> Firecrawl, `youtube-pp-cli` -> YouTube: call text = first subcommand word with dashes as spaces, else `run`.
   - `browser-harness`, `agent-browser` -> Browser: call text `run script`, no summary.
   - CLI summary: the value of a `q`, `query`, `id`, `fileId`, `spreadsheetId`, `documentId`, `calendarId` or `url` key inside JSON params (quotes may be escaped); else the first http(s) URL; else the rest of the line with a heredoc marker and leading subcommand words removed. Cut to 60.

#### 2.2 Display name of an MCP server

- Readable server (anything that is NOT a random id; a random id = 8 hex chars, a dash, then hex and dashes): strip a leading `plugin_<plugin>_` and a leading `claude_ai_` (any case). Look the rest up case-insensitively in the known-name list below; if not found, title-case it (split on `-`, `_`, spaces, capitalise each word, join with spaces). Example: `plugin_demo_fireflies` -> Fireflies; `claude_ai_Slack` -> Slack.
- Random-id server (claude.ai connectors, id differs per account): name it by the tool name, testing the tool-name hints below in order, first match wins. A match is remembered for that server id (module lifetime), so a later tool of the same server that matches nothing (or would be ambiguous) gets the same name. No match and nothing remembered: `Connector`. A raw id is never shown.

Known server names (server key -> display): google-workspace Google Workspace; gmail Gmail; google-calendar Google Calendar; google-drive Google Drive; chat-relay Chat Relay; handoff Handoff; vidiq vidIQ; apify Apify; claude-in-chrome Chrome; claude_browser Browser; fireflies Fireflies; posthog PostHog; pipedrive Pipedrive; pandadoc PandaDoc; firecrawl Firecrawl; attio Attio; composio Composio; figma Figma; stripe Stripe; shopify Shopify; notion Notion; slack Slack; calendly Calendly; youtube YouTube; kit Kit; circle and circle-community Circle; supabase Supabase; vercel Vercel; make Make; higgsfield Higgsfield; github GitHub; linear Linear; hubspot HubSpot; reddit Reddit.

Tool-name hints for id servers, in priority order (case-insensitive unless noted):
1. Fireflies: prefix `fireflies_`. 2. Notion: prefix `notion-`. 3. vidIQ: prefix `vidiq_`. 4. Slack: prefix `slack_`. 5. Composio: prefix `composio_`.
6. Higgsfield: prefixes `ads_studio_`, `ai_influencer_`, `scene_builder_3d_`, `shorts_studio_`, `tiktok_`. 7. Meta Ads: prefix `ads_`.
8. Calendly: prefixes `availability-`, `event_types-`, `meetings-`, `routing_forms-`, `scheduling_links-`, `shares-`, `locations-`, `users-`, `organizations-`, or containing `calendly`.
9. Gmail: exact names for threads/messages/drafts/labels/trash/spam (search_threads, get_thread, get_message, list/get/create/update/delete draft(s), list/create/update/delete label(s), (un)label thread/message, (un)trash thread/message, (un)mark thread/message spam, apply sensitive thread/message label, update_message_labels, forward, reply).
10. Google Calendar: list_calendars, respond_to_event, suggest_time, search_events.
11. Google Drive: list_recent_files, search_files, read_file_content, download_file_content, get_file_metadata, get_file_permissions, share_file, trash_file, copy_file.
12. Google Sheets: get_spreadsheet, get_values, update_values, append_values, batch_clear_values, update_formulas, insert_dimension, update_spreadsheet, copy_sheet_to_another_spreadsheet.
13. Kit: contains subscriber, broadcast, sequence, landing_page, snippet, growth_stats, email_template, creator_profile or email_stats.
14. Circle: contains community_member, space/spaces as a word, space_group, space_member, course lesson/section, access_group, member_tag, tagged_member, live_room, gamification, paywall, flagged_content, filter_kit, post_summary, advanced_search.
15. Apify: actor/actors or dataset as a dash-delimited word, apify, key-value-store.
16. Attio: record/records as a dash-word, prefix semantic-search-, call-recording, run-basic-report, ending -workspace-members/-workspace-teams, -list-entry-, ending attribute-definitions.
17. Make: prefixes like scenario(s), scenario-..., data-store(s), data-store-records, data-structure(s), hooks, hook-..., executions, credential-requests, app-module(s), connections, connection-..., each followed by `_`.
18. Supabase: apply_migration, execute_sql, list_migrations, list_tables, list_extensions, generate_typescript_types, get_advisors, get_publishable_keys, get_project_url, deploy_edge_function, list_edge_functions, get_edge_function, create_edge_function_secret.
19. Vercel: contains deployment, vercel, edge_config, project_domain, sandboxes, named_sandbox, toolbar_, rolling_release, kms_, or ends in _drain/_drains.
20. Figma: get_design_context, get_figjam, use_figma, get_figma_skill, get_variable_defs, create_design_system_rules, search_design_system, send_code_to_figma, add_code_connect_map, get_motion_context; or containing code_connect, shader, generative_plugin; or prefix weave_.
21. AnyMailFinder: find_person_email(s), find_company_email(s), find_decision_maker_email(s), verify_email, report_bad_email.
22. Vibe Prospecting: match-/enrich- + business/prospects; fetch-entities, fetch-businesses-events, fetch-prospects-events, fetch-entities-statistics.
23. YouTube (case-sensitive camelCase): getTranscripts, getVideoDetails, searchVideos, getChannelStatistics, getVideoComments, getTrendingVideos, getChannelTopVideos, getVideoCategories.

Fallback display name: `Connector` (key `connector`).

All display names the mod can produce: the known server names above, plus Google Sheets, Google Docs, Meta Ads, AnyMailFinder, Vibe Prospecting, Connector, plus any title-cased unknown readable server name.

#### 2.3 Rows, keys, merging

- Row key = display name lower-cased with everything but a-z0-9 removed, with two aliases: `googleworkspace` -> `google`, `metaads` -> `meta`. Calls with the same key merge into one row (MCP and CLI use of Gmail are one row).
- Per row: name, call count (+1 per call), last-use order, flags "used via CLI" and "used via MCP", and the call list (newest last, capped at the newest 60).
- Each call stores: call text, summary, clock time (now for live calls; transcript time or unknown for seeded calls), CLI flag.
- MCP call text: the tool part split on `-`, `_`, spaces, lower-cased; leading words are dropped while more than one word remains and the word equals the row key or any word of the display name, or looks like `s` + digits (`fireflies_get_transcripts` for Fireflies -> `get transcripts`).
- MCP summary (main argument): the first non-blank string (or number) among, in priority order: query, q, search, searchQuery, keyword, keywords, url, file_path, path, filename, fileName, name, title, subject, transcriptId, threadId, messageId, documentId, spreadsheetId, fileId, pageId, eventId, calendarId, id, email, channel, prompt, skill, command. Else the first non-blank string of any other input key; else the first number/boolean of any other key as `<key> <value>`. Engine metadata keys (tool, tool_use_id, agentId, hook_event_name, session_id, transcript_path, cwd, permission_mode, surface) are never used. A string that looks like a path (starts with `~`, `/` or `.` and contains `/`) is reduced to its last segment. Whitespace collapsed, cut to 60 with `…`.

#### 2.4 Display

Rows ordered by last use, newest first.
- Desktop (surface supports SVG): a grid of tiles, 12 columns each, as many per row as fit. Tile: a 44x40 logo image with the call count in a round accent badge in the top-right corner (`99+` above 99); image alt text `<Name>, N call(s)`; below it the name as a pressable plain button (dim unless its list is open); below that `via CLI` (CLI only), `MCP + CLI` (both) or blank. The open connector's call list appears under the tile row that contains it.
- Terminal: one row per connector: pressable `▸ Name` / `▾ Name` (open), followed by dim ` via CLI` or ` MCP + CLI` when applicable; right side in accent `N call(s)`. The open list appears under its row.
- Press element `c:<key>` opens that connector's call list; pressing the open one closes it; opening another closes the previous (one open at a time, kept in `$.state`).
- Call list: dim heading `<Name> calls, newest first`, then calls newest first (max 40 drawn, `+N more`): call text, then two spaces and the summary in dim; right side dim `CLI ` (for CLI calls) + clock time `HH:MM` local (blank when unknown).

#### 2.5 Logos

Logo used when the row key has one; fallback: a rounded square in the accent colour with the first letter of the display name, upper-case, in white (`?` if no name). Current logo keys (for coverage checks): gmail, googlecalendar, googledrive, googlesheets, googledocs, google, notion, slack, stripe, calendly, figma, vercel, supabase, make, youtube, shopify, meta, attio, fireflies, kit, circle, vidiq, posthog, apify, higgsfield, anymailfinder, composio, firecrawl, pipedrive, pandadoc (pandadoc is a placeholder, not the real mark). Names with no logo today (letter badge): Chat Relay, Handoff, Chrome, Browser, GitHub, Linear, HubSpot, Reddit, Vibe Prospecting, Connector, any title-cased unknown. (The rewrite plans Simple Icons CC0 + a letter badge; check the list above against it.)

---

### 3. Context files

#### 3.1 What counts

- Files read during the chat: every `Read` call (main chat or subagent, not denied), path normalised to forward slashes. Excluded: a path ending in `/<folder>/SKILL.md` (that is a skill, 4.1); the engine's spill files: paths containing `/tool-results/`, starting with `/tmp/` or `/private/tmp/`, or inside `~/.claude/projects/<project>/<36-char session uuid>/`. Only `Read` adds files (not Grep/Glob/Edit/Write).
- Memory files loaded at start: from `$.session.usage({ breakdown: 'summary' })` -> context breakdown memory files (CLAUDE.md, AGENTS.md, MEMORY.md, imports). Loaded on `session.start` and on `/chat-sidecar`, only when the Context files or Skills section is shown. Each non-SKILL.md path is added as an `auto` row if not present; an existing row with that path is marked `auto`. SKILL.md paths become always-loaded skills (4.1), and any old file row that is a SKILL.md is removed. Nothing is changed when the breakdown is missing or has neither.
- One row per path; reading a file again moves it to the top.

#### 3.2 Order and display

- Newest first: files read, latest read on top; memory files below all read files (in reverse load order).
- First line: dim `Files read` with, right-aligned, the number of non-auto rows. Header count = all rows.
- Each row: the file name, two spaces, then the folder in dim, home-shortened; a file at the root shows `/`; a folder longer than 28 chars with more than one segment is shown as `…/<last folder>`. One line per file, truncated at the end. Memory files carry an `auto` tag (info colour) on the right.
- Window: at most 10 rows visible. With more than 10 files, below the window: dim `<a> to <b> of <N>` and two controls `▴ Up` and `▾ Down`, which move the window by 5 rows (elements `files-up`, `files-down`), clamped to the list; at the top `▴ Up` is plain dim text (not pressable), at the end `▾ Down` likewise. The window position is kept in `$.state` and clamped when the list shrinks. With 10 or fewer files, all rows show with no navigation.

---

### 4. Skills

#### 4.1 Detection

- `Skill` tool call: the `skill` argument (leading `/` removed) -> +1 use.
- `Read` of a path ending `/<folder>/SKILL.md` -> +1 use of skill `<folder>` (never a context file).
- A slash command the person typed (`command.run`, after it runs), except `chat-sidecar`, if it is a skill -> +1 use. "Is a skill": the name is among the skill names in the session usage breakdown (skill frontmatter list, also collected while loading memory files); if that list is empty/unavailable, the command list entry with that name has source `user`.
- Always loaded: a SKILL.md among the memory files loaded at start (imported via a memory file) -> row marked `always`; its use count and order are not changed by that.
- Main-chat and subagent calls both count; each tool-use id counts once.

#### 4.2 Display

- Rows ordered by last use, newest first; always-loaded rows never used sit below the used ones.
- Row: accent `/` then the name; right side: `always loaded` (info colour) if always, two spaces when both apply, then dim `N use(s)` if used at least once. Max 40 rows then `+N more`. Header count = number of rows.

---

### 5. Seeding from history and reload

- On `session.start`, once per session id: if the stored seeded session id differs from `$.session.id()`, the history is seeded, then the id is stored. Otherwise (a module reload in the same session, e.g. after any `/config` change) nothing is re-counted; the order counter continues from the highest order value in the stored inventory.
- Seeding reads `$.session.messages()` (main chat) and, for every tool use in it that has an `agentId`, `$.session.messages({ agentId })` for that subagent's messages.
- Every tool use (in order, deduped by `tool_use_id`) is run through the same rules as live calls (sections 2.1, 3.1, 4.1). User messages whose text starts with `/<name>` or contains `<command-name>/<name></command-name>` count as a skill use if `<name>` is a skill.
- Call times for seeded connector calls come from this chat's transcript file `~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>/<session id>.jsonl`: each line with a `tool_use` gives its timestamp to the tool-use ids in it. Missing file or unreadable: times stay unknown (blank clock).
- Seeding does not create subagent cards.
- What survives: module reload keeps inventory, open connector list, file window position, cards and card view state (`$.state`). A new process starts empty and seeds from history again. (unverified) After `/clear` or another event that changes the session id within the same process, a new seed runs and its counts are added on top of the existing inventory (the inventory is not reset).
- Errors in seeding, memory-file loading or any hook are written to the mod's log (`~/.claude/mods-logs/chat-sidecar.log`, last 200 lines) and never break the tool call or the pane.

---

### Acceptance

1. Given a started session, when two calls to a Gmail-tooled id server (search_threads), one Fireflies call, a Read of a note and a Skill call `video-prep` happen, then the pane shows Gmail, Fireflies, the note's name, `video-prep`, the memory file CLAUDE.md with `auto`, the always-loaded skill from a memory SKILL.md with `always loaded`; no SKILL.md appears as a context file; no `None used yet` shows; unused connectors (e.g. Slack) do not show.
2. Given the desktop surface, then there is one logo image per connector, Gmail's alt says `2 calls`, and a connector with a logo shows its real SVG; given the terminal, Gmail shows `2 calls` and Fireflies `1 call`.
3. Given Bash commands `cd ~; gws gmail ...` and `cd ~ && gws calendar ...`, then Gmail and Google Calendar show tagged `via CLI`; `echo gwsx; ls ~/gws` adds nothing (no Google Workspace).
4. Given a Read of `.../skills/foo/SKILL.md`, then a skill `foo` shows and no context file named SKILL.md.
5. Given two connectors with calls, when nothing is pressed no call text shows; pressing `c:gmail` shows `search threads` and its query, and not Fireflies' calls; pressing `c:fireflies` shows its call and closes Gmail's; pressing `c:fireflies` again closes it.
6. Given the mod switched off, then tool calls add nothing and the pane shows no Connectors/Gmail/Skills, only the off line.
7. Given id servers whose tools are `list_landing_pages` then `list_posts` (same server), `list_spaces`, `call-actor`, `notion-search`, a `plugin_demo_fireflies` server, a `claude_ai_Slack` server and an id server with `do_something_new`, then rows `c:kit`, `c:circle`, `c:apify`, `c:notion`, `c:fireflies`, `c:slack`, `c:connector` exist, no raw id text appears, and Kit's list contains both `list landing pages` and `list posts`.
8. Given 14 read files plus one memory file, then at most 10 rows show, `1 to 10 of 15` shows, there is no pressable Up, and the newest file is visible; pressing Down shows `6 to 15 of 15`, the newest is gone, CLAUDE.md is visible and there is no pressable Down; pressing Up returns to `1 to 10 of 15`.
9. Given one file read, then a `Files read` line shows in Context files.
10. Given two spawns (`Read the research notes`/Explore/haiku and `Find invoice threads`/general-purpose/opus) and one call from each, then the section shows `Subagents`, `2 running of 2`, both descriptions, `Step 1 · Reading research.md`, `Gmail: search threads`, a `Running · 2` heading on a blue background and `Explore · Haiku`.
11. Given that, when the first agent's turn completes with usage 1000+500+30000+2000, then a plain (no background) `Finished · 1` heading, `34k tokens` and `1 running of 2` show.
12. Given the second agent's list status becomes `completed`, when 2 s pass, then `Finished · 2` shows and the Running heading is gone.
13. Given the Finished group, pressing `group-finished` hides its cards; pressing again brings them back.
14. Given an agent with six calls (Read, Bash with description, Google Drive id-server `list_recent_files`, Skill, WebFetch, Write), then the live line reads `Step 6 · Writing research.md`, the previous steps include `Opening docs.example.com`, the first step is not shown collapsed, and the toggle says `All 6 steps`; pressing it shows `Hide steps`, kind tags `File read`/`File write`, the first file with its home-shortened folder in dim, `List the temp folder`, `Google Drive · list recent files`, `video-prep`, `docs.example.com`; pressing again collapses it.
15. Given `barParts('done', 6, any, any)`, then it is `['', '██████', '']`; given `'working'` at width 6 for any tick and seat, the three parts total 6.
16. Given any bar style, `agentParts` while working and when done always totals the width; segments done at width 4 is four filled segments; line working is track, heavy piece, track; gradient working is light shade, full blocks, light shade.
17. Given model strings, `claude-opus-5-5` -> `Opus 5.5`, `haiku` -> `Haiku`, `gpt-x` -> `gpt-x`; durations 0 -> `0:00`, 65 s -> `1:05`, 3725 s -> `1:02:05`.
18. Given step descriptions: Read of a home path -> File read, file name, `~/...` folder, `Reading <name>`; Edit of a Windows backslash path with a Windows home -> File write, `~/x`; Bash with description -> Command, `Running: <description>`; id-server `search_threads` -> Connector `Gmail · search threads` / `Gmail: search threads`; Agent with description -> `Starting a subagent: <description>`; unknown tool -> Tool, `Using <tool>`.
19. Given a module reload in the same session, then history is not counted again (counts stay the same) and cards, open lists and window position are kept (from `$.state`; verified live only, the test rig has no real reload).

---

# Part 3: hosting the kept modules (Background, Git, Tasks for me)

Scope: how the rewritten main module (`hooks/register.tsx`), `hooks/helpers.ts`, `hooks/band.ts` (where it is rewritten) and the types after the marker line in `types/index.d.ts` host the KEPT modules `hooks/background.ts`, `hooks/git.ts`, `hooks/parse.ts`, `hooks/barstyle.ts` and `hooks/tasks/*`. Other parts (to-do, plan band drawing, subagents, connectors, files, skills, settings screen) are specified elsewhere and appear here only where they touch this part.

Terms: "the pane" = the side pane with id `chat-sidecar`, title `Sidecar`. "off" = switches.json turns the mod off. "hidden" = switches.json hides the pane. "inner width" = pane width minus 4, where pane width = the larger of 20 and the render's `bodyColumns`. "Write only when changed" = compare the new value with the stored one (deep/JSON equality) and skip the write when equal.

---

### 1. Kept-module exports the main module (and other rewritten files) must use or provide

#### 1.1 Imported from `parse.ts` (kept; signatures as they are)
- `settings(options) -> Settings`: read once per module load from the `register(on, options)` options. The fields this part uses: `sections.shown.background`, `sections.shown.git`, `sections.shown.tasks`, `sections.order`, `watched` (port -> label map), `pollMs`, `jobsMs`, `age`, `barStyle`, `bandColor`, `problems` (strings; each is written to the debug log at session start as `config: <problem>`).
- `level(entry: { port?: number; minutes: number }, age) -> 'ok' | 'warning' | 'error'`: an entry with a port uses the server limits (warning at `serverWarnHours`, never error); without a port the test limits (`testWarnMinutes`, `testErrorMinutes`).
- `ago(minutes) -> string`: `12m`, or `1h05m` from an hour on.
- Also exported and used by other parts: `SECTION_IDS`, `SHOW_FIELD`, `DEFAULT_ORDER`, `DEFAULT_PORTS`, `parsePorts`, `SectionId`, `Settings`, `SUREFIRE`, `bar`.
- Setting keys involved (plugin.json `userConfig`, unchanged): `showBackground`, `showGit`, `showTasks`, `ports`, `pollSeconds` (default 10, floor 2), `jobsSeconds` (default 30, floor = pollSeconds), `testWarnMinutes` (15), `testErrorMinutes` (30), `serverWarnHours` (8), `barStyle`, `bandColor`, `sectionOrder`.

#### 1.2 Imported from `background.ts` (kept)
- `poll($, cfg: Settings, windows: boolean, prev: Listener[]) -> Promise<Listener[] | null>`: one scan. Returns the new full list when something visible changed, `null` when nothing changed, when a scan is already running, or on failure. Never throws in practice (catches internally), but the caller still guards it. It runs the port scan every call and the process scan only when `cfg.jobsMs` has passed since its last process scan (its own module clock). It reads and writes `$.store` keys `total:<project root, lowercased>` (remembered surefire totals). It keeps module variables (last process scan, in-flight surefire run, report cache) that reset on a module reload.

#### 1.3 Imported from `git.ts` (kept)
- `readGit($) -> Promise<GitInfo | null>`: the facts for the session's folder; `null` outside a repo, with no commit, or without git. Runs `git rev-parse` every call and the base lookup (reflog, for-each-ref, rev-list) only once per (repo, branch) per module load (its own cache, reset by a reload). A detached HEAD gives branch `HEAD` and no base.

#### 1.4 Imported from `barstyle.ts` (kept)
- `planCells(style, { done, total, isLive, barW, tick, palette: { light, mid, deep } }) -> Cell[]` with `Cell = { ch, color?, dim? }`. Used here for the 10-cell test-run bar.

#### 1.5 Names KEPT modules import from rewritten files (must be provided exactly)
- From `band.ts` (imported by `parse.ts` and `barstyle.ts`):
  - `BAND_COLOR_IDS`: the band colour ids, in exactly this order: `purple`, `green`, `burgundy`, `navy`, `orange` (parse.test pins the order through the problem text `bandColor: pink is not one of purple, green, burgundy, navy, orange, purple used`).
  - `BandColor`: the type of one of those ids.
  - `mix(a: string, b: string, t: number) -> string`: the colour between two `#rrggbb` colours, `t` from 0 to 1, per channel linear and rounded, returned as lowercase `#rrggbb` with two hex digits per channel. `t = 0` returns a string equal to `a` and `t = 1` equal to `b` when those are given lowercase (barstyle.test compares cell colours to the palette strings).
  - The rewritten band also needs, per colour id, a palette with at least `light`, `mid`, `deep` (planCells input); the values are design choices of the rewrite, but the purple palette used by barstyle.test is passed in by the test itself, so no value is pinned there.
- From `helpers.ts` (imported by `barstyle.ts`):
  - `barParts(phase: HelperPhase, w: number, tick: number, seat: number) -> [before, piece, after]`: the subagent card bar, three strings whose lengths sum to `w`. Phase other than `working`: `['', '█' repeated w, '']`. Working: a piece of `max(3, floor(w/4))` cells of `█` slides left to right over a `░` track; its head position cycles with `tick` over a span of `w + piece`, offset by `seat * 5`, and it is clipped at both ends (it enters from the left and leaves to the right; the piece part is never longer than `w` and can be shorter while entering or leaving). barstyle.test needs: total length `w` in every style and phase, a working gradient bar reading `░…█…░` with at least one `█` at `w=12, tick=3, seat=0`, and a done bar fully filled.
- From `types/index.d.ts` (before the marker, kept): `HelperPhase`, `GitInfo`, `Listener`, `Task`, `TaskKind`, `TaskState`, `TaskUpdate`, `TaskRef`, `Took`, `Editing`. The rewrite only replaces what follows the marker line, which includes the `PluginState['chat-sidecar']` declaration (section 4).

#### 1.6 Own helpers the rewrite must re-create (behavior only)
- Port grouping (today `portGroups(watched, servers)`): input the watched port map and the current port entries (Listener entries that have a port). Output: one group per label, groups ordered by their lowest port, ports inside a group ascending. Each port has a state:
  - `idle`: no entry on that port;
  - `up`: an entry whose process image is `?` (unknown: the scan could not tell, so no warning) or is `java`, `javaw` or `node`, with or without `.exe`, any letter case;
  - `foreign`: an entry with any other image (something else holds the port).
  Up and foreign ports carry their entry (image, pid, minutes).
- One-line background entry text (today `backgroundLine`): label, then ` :<port>` when it has a port, then ` ×<count>` when count > 1, then for a test run with progress ` <done>` or ` <done>/<total>` (the total only when known and done ≤ total). Examples: `backend :8090`, `backend tests (surefire) ×3 412/924`, `vitest ×2 40`. NOTE: it is exported and unit-tested (helpers.test.ts, not a kept test) but NOT used by the pane drawing; the rewrite may drop it or keep it.

---

### 2. Background section

#### 2.1 Switching and environment
- At session start the module learns: the home folder (env `USERPROFILE`, else `HOME`, else the plugin root's part before `/.claude/`; backslashes turned into `/`, trailing slash dropped; every env read guarded, a failure counts as unset), and whether it runs on Windows (env `OS` equals `Windows_NT`). That flag is the `windows` argument of `poll`.
- Off (switches.json `"chat-sidecar": false`): no scan runs (a tick returns at once), and when the mod turns off the stored list is emptied. Turning on again lets the next tick scan; no extra immediate scan is required.
- Hidden does NOT stop scanning.

#### 2.2 Cadence
- At session start, when `showBackground` is on: one scan at once (not awaited by session start), and a repeating timer every `pollMs`. The timer is created once per module instance: session start comes again on clear, compact, resume and module reload, and must not add a second timer. Every tick re-checks off and the section setting before calling `poll`.
- When `showBackground` is off at load: no scan and no timer; the stored list is emptied (fire-and-forget, errors ignored).
- The process-scan interval (`jobsMs`) is handled inside `poll`; the host just passes `cfg`. Expected effect with defaults: one port scan per 10 s, process scans at 0, 30, 60 s.
- Settings changes reload the module (new `options`), so cadence follows the new values after the reload's session start.

#### 2.3 Storing results
- The host passes the currently stored list as `prev`. A `null` result writes nothing. A list result is written to state key `listeners` (only if not off meanwhile), then the host asks for a redraw of `ui.render`.
- The `listeners` value is kept under an atom shape tag (today `v3`); a reload under a different tag reads it as empty, which is intended when the `Listener` shape changes. Since `Listener` is kept, the tag may stay.
- Any thrown error is written to the mod's error log (`<home>/.claude/mods-logs/chat-sidecar.log`, see the logging part) with the place `background`; nothing else changes.

#### 2.4 Drawing (pane section `background`, title `Background`)
Entries with a port are servers; entries without one are test runs.

Port groups (one block per group from the port grouping, in group order):
- A row: the label in a column as wide as the longest label (at most 12, truncated at the end), coloured with the theme colour `permission` when the label is `debug`; then one chip per port, wrapped as needed, two columns apart.
- Chip = a plain button with element id `bg-port-<port>`, text:
  - up: `:<port> ●` then a space and the age (`ago(minutes)`); the dot is coloured `success`, or `permission` for the `debug` label. Example `:8090 ● 3h05m`.
  - idle: `:<port> ○`, port text and circle dim.
  - foreign: `:<port> ⚠ <image without a trailing .exe>` in colour `warning`. Example `:4200 ⚠ svchost`.
- Age colour (servers and test runs): ok = dim; warning = colour `warning`; error = colour `error` and bold. Servers turn yellow after `serverWarnHours` and never red; tests turn yellow after `testWarnMinutes` and red after `testErrorMinutes`.
- Pressing a chip opens that port's details under its group; pressing the same chip again closes them; at most one port's details are open (state key `bgOpen`: port number or null). Details, indented:
  - with an entry: `:<port> · <image> · pid <pid>` (image as is, `.exe` kept), dim, truncated;
  - without: `:<port> · nothing listening`, dim;
  - foreign also: `<image> holds the port, so the <label> server cannot start on it.` in colour `warning`, wrapped;
  - up and label not `debug`, and the surface offers a `Link` element: a link to `http://localhost:<port>`. No link for idle or foreign ports.
- Idle groups: a group is idle when every port in it is idle (a foreign port makes it not idle). When at least one group is idle, a plain dim button `bg-idle` follows the groups: `▾ hide <n> idle` while shown, `▸ <n> idle` while hidden; pressing toggles state key `bgHideIdle`. While hidden, idle groups are not drawn.

Test runs (after the groups):
- A dim bold heading `Tests`, only when at least one run exists.
- One row per run: a `◐` in colour `suggestion`; the text `<label>` plus ` ×<count>` when count > 1 (truncated); when progress has a total and done ≤ total, a 10-cell bar from `planCells` in the configured `barStyle` with the configured band colour's palette, not live, tick 0; then dim progress text `<done>/<total>` (when the total applies) or `<done>`; then the age as above.

Header right text:
- When any port is watched: `<up> of <all> up`, plus ` · <n> ⚠` when n > 0 ports are foreign. Example `1 of 5 up · 1 ⚠`.
- Else, when runs exist: the number of runs. Else empty.

Empty state: no groups (no watched ports) and no runs: dim `Nothing running in the background.` With watched ports configured the groups always show (all idle when nothing runs).

Section visibility: drawn when `showBackground` is on; foldable by its header like any section (part 1/2 rules).

---

### 3. Git section

#### 3.1 When `readGit` runs
- At session start when `showGit` is on: once at once (not awaited), then every 60 s (one timer per module instance, same guard as Background).
- After a tool call in the main chat (no agent id) that was not denied, whose tool is `Bash` and whose command contains the word `git` followed by whitespace. A subagent's git call does not trigger a read.
- Never while off or with `showGit` off (not even after a git Bash call).
- Result handling: compare with the stored state key `git`; write only when changed (and not off meanwhile), then ask for a `ui.render` redraw. Errors go to the error log with place `git`.
- `showGit` off at load: store `null` (fire-and-forget). Turning off via switches.json: store `null`.

#### 3.2 Drawing (pane section `git`, title `Git`)
- Drawn only when `showGit` is on AND the stored info is not null. Outside a repo it is not drawn at all; if it was the only section on, the pane shows the "all sections are off" line of the general pane part.
- Header right text: the branch name (`HEAD` when detached).
- Rows (label left dim, value right), element ids `git-base`, `git-worktree`, `git-main`:
  - `Base`: the base branch, followed by dim ` · <baseCommit>` when present (e.g. `origin/dev-next · 69ec47d`); dim `unknown` when no base.
  - `Worktree`: `yes` or `no`.
  - `Main repo`: only when known; the path with the home folder replaced by `~`, cut at the end with an ellipsis to the larger of 8 and (inner width − 11) characters; the text element also truncates from the start if it still overflows.

Element ids `bg-port-<port>`, `bg-idle`, `git-base`, `git-worktree`, `git-main` (and a details container per open port) are not used by any kept test; they are the ids the rewritten register tests should use.

---

### 4. State keys (`PluginState['chat-sidecar']`, declared after the marker)

The tasks module declares its own atoms on these keys with these exact value types; the declaration must allow them:

| key | value type | owner |
|---|---|---|
| `tasks` | `readonly Task[]` | tasks module (host only reads it) |
| `nextId` | `number` | tasks |
| `took` | `Readonly<Record<string, Took>>` | tasks |
| `editing` | `Editing \| null` | tasks |
| `loadedFor` | `string \| null` | tasks |
| `isWorking` | `boolean` | tasks |
| `held` | `readonly string[]` | tasks |
| `elsewhere` | `boolean` | tasks |
| `elsewhereList` | `readonly { folder: string; task: Task }[]` | tasks |
| `answeredOpen` | `boolean` | tasks |

Keys this part of the host uses (names may change only if no kept module or kept test relies on them; none does):
- `listeners`: `Shaped<Listener[]>` (atom with a shape tag).
- `git`: `GitInfo | null`.
- `bgOpen`: `number | null`; `bgHideIdle`: `boolean`.
- Shared with other parts: `off`, `folded` (includes `tasks` when Tasks for me is folded), `settings` (`open` flag of the settings screen), `autoOpened`.

The engine accepts `read`/`update` only on an atom declared as a `const` in the same file. So the host declares its own atom on `{ plugin: 'chat-sidecar', key: 'tasks' }` (same initial empty list) as a read-only mirror of the tasks module's, and its own atom for every other key it touches; it never imports the tasks module's atoms. `background.ts` cannot write state for the same reason: it returns the list and the host writes it.

`background.ts` and `git.ts` use no `$.state` keys. `background.ts` uses `$.store` keys `total:<root lowercased>`. The tasks module uses `$.store` keys starting with `tasks:`.

Survival:
- Module reload (any userConfig change, code save): all `$.state` keys survive; module variables (off/hidden flags, home, windows flag, timers, settings) reset and are rebuilt by the session start the reload brings. background.ts forgets its in-flight surefire run, its last process scan (so the next poll scans processes at once) and its report cache; git.ts forgets its base cache (so the base is looked up once more).
- New session: `$.state` starts empty (unverified whether `/clear` within one process keeps it; the host must not rely on either). `$.store` (surefire totals, tasks) and switches.json persist across sessions.

---

### 5. Tasks for me hosting

#### 5.1 Hook ownership (one hook per event and matcher per module)
- `registerTasks(on, options, { isOn })` registers, and the host must NOT register the same event+matcher: `session.end`; `command.run` with matcher `{ command: 'my-tasks' }`; `tool.describe` and `tool.call` with matcher `{ tool }` for `mcp__chat-sidecar__assign_task`, `mcp__chat-sidecar__list_tasks`, `mcp__chat-sidecar__withdraw_task`; `turn.start`; `prompt.submit`; `prompt.compose`; `prompt.context`; `ui.render` for `{ component: 'ToolUse', props: { tool: assign_task } }`; `session.attach`; `ui.focus` with `{ requestId: 'chat-sidecar' }`.
- The host's own unmatched `tool.call` and `command.run` hooks coexist with those matched ones, which requires them to call `next(e)` and hand its result back unchanged (no added `text`, no change to `result` or `deny`): the kept `/my-tasks` test expects the reply's `text` to be undefined, which is the tasks module's empty answer flowing up through the host.
- Because the host owns `session.start`, `turn.step`, `turn.complete` and `ui.render AbovePrompt`, the tasks module's parts of those run through the functions below.
- The host's catch-all `ui.press` handler(s) must pass every element they do not own on with `next(e)` (the task cards' buttons, `t-answered`, `elsewhere-toggle`, etc.).
- The host's general `tool.call` hook must not list the task tools (server `chat-sidecar`) as a connector.

#### 5.2 Every call into `hooks/tasks/register.tsx` / `tasks/tasks.ts`
1. `registerTasks(on, options, { isOn: () => <not off> })`: once, at the end of `register`. `isOn` must read the live off flag each time (not a snapshot taken at load). The tasks module then refuses `assign_task` and answers `/my-tasks` with its own off text while off.
2. `tasksOnSessionStart($)`: in the host's `session.start`, awaited, errors caught and logged (`tasks session.start`). Order inside session start: (a) home folder and Windows flag; (b) read switches.json (off/hidden) and wait for it; (c) `tasksOnSessionStart`; (d) open-at-start (5.4); (e) the rest (command and plan-tool registration, timers, seeding). It must not wait on anything of the pane's. It registers the three task tools and `/my-tasks`, closes a leftover pane with id `my-tasks` (errors ignored) and joins the project (which may itself bring the pane up via `sidecarShowTasks($, false)`).
3. `tasksOnTurnStep(e)`: synchronous, first thing in every `turn.step` (main and subagents), before `next`; not skipped while off.
4. `tasksOnTurnComplete($, e)`: in every `turn.complete`, after `next` has resolved, awaited, errors caught and logged; not skipped while off.
5. `tasksOnAbovePrompt($, e.props.isWorking)`: synchronous, the very first thing of every `ui.render AbovePrompt` call, before any off, hidden or survey check, in its own try/catch (an error is logged and drawing goes on). The kept test redraws the band with `isWorking` true then false and needs this to land even when the host draws nothing of its own.
6. `tasksBeforeOpen($)`: right before every `$.ui.open` of the pane (`/chat-sidecar`, open-at-start, `sidecarShowTasks`), awaited, errors caught. The host itself never calls `$.ui.panes()` (a kept test checks it is asked 0 times when no draft exists).
7. `tasksSection($, els, e.surface, e.props.isFocused, columns)`: in the Pane render, only when the Tasks for me section is drawn and open; `els` is the surface's resolved elements; `columns` = inner width (pane width − 4, pane width at least 20). The returned element is the section body.
8. `tasksUndrawn(e.surface)`: synchronous, in the Pane render whenever this render does not draw the tasks body: the off screen, the settings screen, and when the section is not drawn or is folded.
9. `tasksShow($)`: when the band's `band-tasks` button is pressed (errors caught and logged); same as `/my-tasks`.
10. `isShown(task)` (from `tasks/tasks.ts`): true for an open/active task or one whose response is pending delivery; used to decide the section's visibility.

#### 5.3 The reverse import: `sidecarShowTasks($, isAsked): Promise<boolean>`
Exported from the main module `hooks/register.tsx` under exactly this name, as a plain `function` declaration (the engine's validator rejects passing `$` to a name bound to a function expression; the circular import works only because it is a hoisted declaration called later). Behavior, in order:
1. Off: resolve `false`; nothing opens, nothing is written.
2. Hidden and not asked: resolve `false`; nothing opens, switches.json is not written.
3. Hidden and asked: un-hide: read switches.json (missing = empty object), remove the `chat-sidecar:hidden` key, write the whole file back (pretty JSON, two-space indent, trailing newline; a failure is logged and ignored), clear the hidden flag.
4. Close the settings screen if it is open (only its `open` flag changes).
5. Unfold Tasks for me (remove `tasks` from the folded list if present).
6. `tasksBeforeOpen($)`, then `$.ui.open({ id: 'chat-sidecar', title: 'Sidecar' })`, adding `focus: true` only when asked.
7. Resolve the open result's `isPlaced` (false when the surface could not place it, e.g. a narrow terminal unasked; the tasks module then shows its own toast).
The host shows no toast on this path.

#### 5.4 Pane opening and hiding the tasks tests rely on
- Open-at-start: in an interactive session, when not off, not hidden and state `autoOpened` is false: set `autoOpened` true, then open the pane without focus (through `tasksBeforeOpen` + `$.ui.open`). It is fire-and-forget: session start does not await it. tasks.test ~1955-1965 expects no open recorded right after `session.start` resolves while ~852 counts three opens (start, the task, `/my-tasks`) later; awaiting the open inside session start breaks the first. Today three engine round trips precede the open on that path (read `autoOpened`, write `autoOpened`, and `tasksBeforeOpen`'s read of `editing`); fewer risks the open landing before session start resolves, more is safe as long as the open lands before the later assertions (~852, ~2887). (unverified: exact timing.)
- `/chat-sidecar` (host command): off -> text reply, no open; hidden -> un-hide as in 5.3 step 3; then open without focus.
- Element `pane-hide` (button in the pane's top row): sets hidden (write `"chat-sidecar:hidden": true` into switches.json, whole file), closes the pane (`$.ui.close({ id: 'chat-sidecar' })`, errors ignored), and toasts `Chat sidecar hidden. Type /chat-sidecar to show it again.` (toast failure ignored). This is the only toast the host makes on these paths.
- Switch re-read: switches.json is read at session start and then every 3 s (one timer per module). `off` = the `chat-sidecar` key is exactly `false`; `hidden` = the `chat-sidecar:hidden` key is exactly `true`. A missing file means neither. A file that cannot be read or parsed keeps the last state. A non-object JSON counts as empty. Becoming hidden closes the pane. A change of off writes state `off`, empties `listeners` and `git` when turning off, and asks for a redraw. No state write when nothing changed.
- No `ui.open` gate for id `my-tasks` exists any more (it belonged to the pre-merge chat-pane); the rewrite must not add one and must never open a pane with id `my-tasks`.

#### 5.5 Drawing Tasks for me in the pane
- The section (container key `tasks`, header button `sec-tasks`, title `Tasks for me`) is drawn when `showTasks` is on OR at least one task `isShown` (a waiting task is never out of sight, even with the section turned off in settings), at its place in the section order.
- Header right: the number of tasks in state `open`, empty when none. While any task is open, the frame (border colour), title and count are in colour `warning`; otherwise the frame has no colour.
- Folded (`sec-tasks` toggles `tasks` in the folded list): header only, and `tasksUndrawn(surface)`.
- The body is whatever `tasksSection` returns (including its empty line `Nothing waiting for you.`).
- Off: the pane draws only the off line and calls `tasksUndrawn`. Settings screen open (`pane-settings` opens it, `set-done` closes it): sections are not drawn and `tasksUndrawn` is called.

#### 5.6 The band's task count (AbovePrompt)
- After `tasksOnAbovePrompt`: when off or the prompt shows a survey, return the lower hooks' drawing unchanged.
- The count of tasks in state `open` shows as a plain button `band-tasks` with bold `warning` text `● <n> for you`, also when the pane is hidden, the to-do section is off or there is no plan. With nothing open and no plan, the host adds nothing.
- The host always keeps the drawing of the hooks beneath (`next(e)`) and adds its band below it, never replacing it (kept test looks up the engine's element `engine`). A lower drawing that is the engine's own placeholder type is not nested (other part).
- Pressing `band-tasks` calls `tasksShow($)`.

#### 5.7 Host contract checklist for the kept tasks test rig (tasks.test.tsx ~175-378)
- [ ] Plugin name and state namespace `chat-sidecar`; pane id `chat-sidecar`, title `Sidecar`; pane renders on `ui.render { component: 'Pane', requestId: 'chat-sidecar' }` for terminal, desktop and mobile.
- [ ] Switches path `<home>/.claude/mods/switches.json`, read via `$.fs.exists` then `$.fs.read`; keys `chat-sidecar` (false = off) and `chat-sidecar:hidden` (true = hidden); written via `$.fs.write` (whole file).
- [ ] Re-read at most every 3 s (tests advance 3.5 s after changing the file).
- [ ] Element ids: `sec-tasks`, `pane-settings`, `set-done`, `pane-hide`, `band-tasks`; section container key `tasks`.
- [ ] Session start order: switches, then `tasksOnSessionStart`, then the fire-and-forget open-at-start.
- [ ] `sidecarShowTasks` exact behavior (5.3), `isPlaced` returned, `focus: true` only when asked.
- [ ] `tasksBeforeOpen` before every pane open; host never calls `$.ui.panes()`.
- [ ] `tasksUndrawn` on the off screen, the settings screen, and when the section is not drawn or folded.
- [ ] `tasksSection` columns = max(20, bodyColumns) − 4.
- [ ] `tasksOnAbovePrompt` first in every AbovePrompt render; the lower drawing kept.
- [ ] `tasksOnTurnStep` before `next`, `tasksOnTurnComplete` after `next`, neither gated by off.
- [ ] No host toast on open/assign paths; the only host toast is on `pane-hide`.
- [ ] The host reads state key `tasks` only while rendering (Pane and AbovePrompt) and makes no state writes on timers when nothing changed: the rig's slow-read hook delays the next read of `tasks` by whoever reads first, so a stray read (or a redraw caused by a needless write) steals it.
- [ ] Engine calls the rig answers, which the host may use in tasks-only runs: `fs.exists`, `fs.read` (only switches.json; any other path throws ENOENT), `fs.write`, `ui.open`, `ui.close`, `ui.panes`, `ui.focus`, `ui.toast`, `ui.status`, `ui.log`, `tool.register`, `command.register`, `session.id`, `session.root`, `session.messages`, `session.usage`, `state.*`, `store.*`, `prompt.*`, the mock clock.
- [ ] Engine calls the rig does NOT answer, each of which must be guarded so that a failure changes nothing visible and throws nowhere: `env.get` (home falls back to the plugin root), `process.run` (Git is on in the rig: `readGit` yields null and nothing is drawn or written), `config.list` / `config.set` (the settings screen opened by `pane-settings` must still render, treating the rows as empty), `command.list`, `agent.list`, `ui.invalidate`, reading the error log file (missing = empty).
- [ ] The rig turns off every section except Tasks for me and Git via options (`showTodo`, `showSubagents`, `showBackground`, `showConnectors`, `showFiles`, `showSkills` false); the host must start no scans for those.

---

### 6. Empty, error and limit states (summary)
- Background: scan failure keeps the previous servers and their ages (inside `poll`); a thrown error is logged; no watched ports and no runs -> `Nothing running in the background.`; macOS has no port scan (no `netstat`/`ss` output), so all ports read idle (unverified on macOS).
- Background: with Maven in two projects at once, progress follows the first one found (kept limit of background.ts).
- Git: outside a repo -> section absent; base unknown -> `unknown`; no main repo -> row absent.
- Tasks: off -> assign refused by the tasks module, pane shows only the off line, band shows nothing of its own; hidden -> unasked shows stay hidden (tasks module toasts), asked shows un-hide.

---

### Acceptance

1. Given default settings on Windows, when the session starts and 60 s pass, then the port scan ran once at start and once per 10 s, the process scan at 0, 30 and 60 s, and a second session start in the same module added no timer.
2. Given a server listening on 8090 (java.exe) and nothing on the other default ports, when the pane draws, then the Background header reads `1 of 5 up`, chip `bg-port-8090` reads `:8090 ●` and an age, chip `bg-port-8091` reads `:8091 ○`, and the label `frontend` is drawn though nothing runs there.
3. Given 4200 held by svchost.exe, when the pane draws, then the header reads `1 of 5 up · 1 ⚠` and the chip reads `:4200 ⚠ svchost`; when it is pressed, the details say `svchost.exe holds the port, so the frontend server cannot start on it.` and no link is shown.
4. Given the 8090 server is up, when its chip is pressed, then `:8090 · java.exe · pid <pid>` and a link to `http://localhost:8090` show; when pressed again, they close.
5. Given a port labelled `debug` is up, then its label and dot use the `permission` colour and its details have no link.
6. Given every port idle, when `bg-idle` is pressed, then idle groups disappear and the button reads `▸ <n> idle`; pressed again it reads `▾ hide <n> idle` and the groups return.
7. Given three surefire forks running, then a `Tests` heading and a row `backend tests (surefire) ×3` show; after 16 minutes its age is in the warning colour, after 31 minutes in the error colour and bold, while a server of the same age stays dim.
8. Given a remembered surefire total of 40 and 30 tests done, with `barStyle` segments, then the run row shows the bar `▰▰▰▰▰▰▰▰▱▱` and `30/40`; with no remembered total it shows only the count.
9. Given switches.json turns the mod off before the session starts, when 60 s pass, then no netstat, ss, PowerShell, ps or git command ran.
10. Given `showBackground` off, then no port scan runs and the section is not drawn.
11. Given a worktree on `feat1` created from `main`, when the session starts, then the Git section shows `feat1` in its header, `Base` main, `Worktree` yes and the main repo path; after 60 s exactly one more git command ran; a main-chat `git switch main` Bash call causes one more read; a subagent's git call causes none.
12. Given the folder is not a repo and only Git is on, then no Git section is drawn and the all-sections-off line shows.
13. Given a branch made from a commit held by `origin/dev-next` (0 ahead) and `origin/develop` (40 ahead), then `git-base` reads `origin/dev-next · <short commit>`.
14. Given `showGit` off, then git never runs, even after a main-chat git Bash call.
15. Given an interactive session, not off or hidden, when it starts, then the pane opens once without focus, and a module reload does not open it again.
16. Given a task is assigned and the pane can be placed, then the pane opens without focus and the host makes no toast.
17. Given the pane is hidden, when a task is assigned, then no pane opens; when `/my-tasks` runs, then the hidden key is removed from switches.json, the settings screen closes, Tasks for me unfolds and the pane opens with focus.
18. Given the mod is off, when `sidecarShowTasks` is called asked or unasked, then it resolves false and opens nothing.
19. Given `showTasks` off and nothing waiting, then no Tasks for me section; when a task is assigned, then the section shows with the task and its buttons.
20. Given open tasks, then the Tasks for me frame, title and count are in the warning colour; when all are withdrawn, then the body reads `Nothing waiting for you.` and the frame has no colour.
21. Given two open tasks and the pane hidden, then the band shows `● 2 for you`; pressing `band-tasks` opens the pane.
22. Given a draft typed in an answer field, when the section is folded and unfolded, or the settings screen is opened and closed, or the pane is hidden and brought back with `/my-tasks`, then the field still holds the draft (host calls `tasksUndrawn` and `tasksBeforeOpen` as specified).
23. Given no draft and no open field, when tasks are assigned and `/my-tasks` runs, then the host never asked which panes are open.
24. Given an AbovePrompt render with `isWorking` true and then false, then the tasks module learned both values and the lower hooks' element is still in the drawing.
25. Given a module reload, then `listeners`, `git`, `bgOpen`, `bgHideIdle` and all task keys keep their values; timers are created anew once.

`hooks/tasks/tasks.test.tsx`, `hooks/parse.test.ts`, `hooks/git.test.ts` and `hooks/barstyle.test.ts` must pass unchanged.
