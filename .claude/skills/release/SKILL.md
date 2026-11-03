---
name: release
description: Release chat-sidecar as a major, minor or patch version - bump, tag, push; GitHub Actions publishes the release.
disable-model-invocation: true
argument-hint: "major | minor | patch"
---

Release what sits under `## Unreleased` in `CHANGELOG.md`. The argument is the bump: `major` (1.0.0), `minor` (0.1.0) or `patch` (0.0.1). With no argument, propose one from the Unreleased entries (a new feature or changed behaviour is minor, fixes alone are patch, a breaking change is major) and wait for the user's pick.

1. **Start from main.** `git fetch origin`, then work on `origin/main` itself: in the main checkout `git switch main && git pull --ff-only`; in a worktree, where main is checked out elsewhere, `git switch --detach origin/main`. Tracked files clean. `## Unreleased` in `CHANGELOG.md` holds at least one entry; when it is empty, stop: there is nothing to release.
2. **Bump.** Read the current version from `.claude-plugin/plugin.json` and compute the next (`major` zeroes minor and patch, `minor` zeroes patch). Write it to:
   - `.claude-plugin/plugin.json` `version`
   - `CHANGELOG.md`: `## Unreleased` becomes `## X.Y.Z`
   - `hooks/register.tsx` line 1: `chat-sidecar X.Y.Z: the main module.`
3. **Check.** `claude plugin validate .` and `claude plugin test .` both pass.
4. **Publish.** Commit `Release X.Y.Z`, `git tag -a vX.Y.Z -m vX.Y.Z`, `git push origin HEAD:main`, then `git push origin vX.Y.Z`. This release commit is the one change that goes to main without a PR.
5. **Confirm.** The tag starts `.github/workflows/release.yml`, which publishes a GitHub Release with the version's CHANGELOG section. Done when `gh release view vX.Y.Z` shows it; when the run fails, show its log (`gh run list --workflow release.yml`, `gh run view <id> --log-failed`).
