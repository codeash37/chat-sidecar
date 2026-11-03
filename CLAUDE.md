# chat-sidecar

## Flow

Every change lands through its own branch and a PR into `main`; the one direct push to `main` is the release commit `/release` makes. A change a user would notice adds a line under `## Unreleased` in `CHANGELOG.md` (create the heading when it is missing).

## Branches

`<type>/<topic>`: type is `feat`, `fix`, `refactor`, `docs`, `test` or `chore`; topic is 2–4 lowercase English words joined by hyphens, naming what changes (`feat/nested-subagents`, `fix/orchestrator-status`). No owner prefix.

## Commits

One line in English, imperative, as `git log` reads: ~50 characters, at most 72, no trailing period.
