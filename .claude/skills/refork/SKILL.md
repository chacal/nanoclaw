---
name: refork
description: Replay base+custom on top of fresh upstream main using a reflect-first, intent-vs-mechanics classification per commit. For bigger upstream jumps where /update-nanoclaw's merge is too coarse.
---

# About

Your fork has three branches: `main` (tracks upstream), `base` (skills/forks merged in), `custom` (linear feature commits). When upstream `main` jumps far ahead, a flat merge buries the question that matters: *for each customization, do we still want it, and if so would we still build it the same way?*

`/refork` walks that question explicitly. It produces a written plan **before** any branch moves, then executes per the approved plan, then halts for manual confirmation before the service switchover.

Differs from `/update-nanoclaw`: that one is a quick merge/cherry-pick path. This one is heavier — written reflection, per-commit classification, staged replay, gated switchover. Use when upstream has shifted enough that "rebase and fix conflicts" stops being the right frame.

## Phases

### 1. Survey (read-only)

```bash
git fetch upstream
git status --porcelain                  # must be clean
```

Compute and read:

- `git log --oneline upstream/main ^main` — new upstream commits we haven't pulled
- `git log --oneline main..base` — base-layer merges/skill installs
- `git log --oneline base..custom` — our linear feature commits
- `git diff --stat main upstream/main` — files upstream touched
- `git diff --stat base custom` — files our custom layer touches

For overlap detection, intersect the file lists from the last two diffs.

Also read `docs/v1-to-v2-changes.md`-style notes or any new top-of-CLAUDE.md banners on upstream for breaking-change signals.

### 2. Reflect & report (output, no changes)

Write a plan file at `docs/refork-<YYYY-MM-DD>.md` with:

**Upstream delta** — commit themes, breaking notes, files touched, anything in upstream's CLAUDE.md that wasn't there before.

**Classification table** — one row per commit in `main..base` (each merge as a unit) and `base..custom`:

| commit | summary | classification | rationale | fresh-build sketch |
|---|---|---|---|---|

Classifications:
- **rebase** — clean replay, no upstream overlap, mechanics still work
- **reimplement** — intent still valid, but upstream changed the surrounding shape; rewrite on the new code
- **drop** — upstream now provides this, or supersedes the need
- **defer** — unclear; flag for the user

The "fresh-build sketch" is one line: *if we were starting from this new `main` today, how would we add this?* That answer drives the choice between rebase and reimplement.

**Replay order** — base layer first (forks/skills via their install skills where possible), then custom commits in original order unless dependencies force a reorder.

**Risks / open questions** — anything that needs the user's call.

**STOP**. Show the plan path. Wait for the user to review, edit classifications, and approve. Do not proceed without explicit go-ahead.

The user may invoke `codex review` themselves for a second opinion. Do not run it automatically.

### 3. Execute (per approved plan)

Branch off:

```bash
git checkout -b refork/<YYYY-MM-DD> upstream/main
```

Replay base layer:
- For each fork/skill in `main..base`: prefer re-running the install skill (`/add-<channel>`, `/add-<provider>`, etc.) on the new `main` so it pulls the current branch tip — that's the "fresh-build" path. Fall back to cherry-pick only when no install skill exists.

Replay custom commits per classification:
- **rebase** → `git cherry-pick <hash>`
- **reimplement** → read the original commit's intent, then implement fresh on the new code as small commits. Don't cherry-pick.
- **drop** → skip; note in execution log
- **defer** → halt and ask

After each meaningful stage:

```bash
pnpm run build
pnpm test
pnpm exec tsc --noEmit
# if container/ touched:
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

`pnpm test` green is not a typecheck. Always run `tsc --noEmit` too.

Append every step to an **Execution log** section at the bottom of the plan file (append-only): commit replayed, classification, command output highlights, anything that needed adjustment vs. the plan.

### 4. Switchover (gated — requires explicit confirmation)

Show:
- `git log --oneline base..refork/<date>` — what changed in the base layer
- `git log --oneline custom..refork/<date>` — what changed in the custom layer
- Final test results
- Any execution-log deviations from the plan

**HALT**. Ask the user to confirm the switchover. Do not proceed without an explicit yes.

On confirm:

```bash
# Backup current tips
git branch base.bak-<timestamp> base
git branch custom.bak-<timestamp> custom

# Fast-forward base and custom to the replayed tip
# (Two refs, same commit, when the replay produced one branch.
#  If base and custom should diverge, the plan must say so —
#  in which case keep refork/<date>-base and refork/<date>-custom separate.)
git checkout base   && git reset --hard refork/<date>-base
git checkout custom && git reset --hard refork/<date>-custom

# Update main to the upstream tip we forked from
git checkout main && git merge --ff-only upstream/main
```

Then restart the service:

```bash
systemctl --user restart nanoclaw       # Linux (this host)
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

Verify port 3000 owner — `systemctl --user restart nanoclaw` can leave a port-3000 orphan because of `KillMode=process`:

```bash
ss -ltnp 'sport = :3000' || lsof -iTCP:3000 -sTCP:LISTEN
```

If a stale PID is still bound, kill it and let the new unit take the port.

Final: print backup branch names so the user can roll back with `git reset --hard base.bak-<timestamp>`.

## Rollback

Every run creates `base.bak-<timestamp>` and `custom.bak-<timestamp>` before the reset. Roll back:

```bash
git checkout base   && git reset --hard base.bak-<timestamp>
git checkout custom && git reset --hard custom.bak-<timestamp>
systemctl --user restart nanoclaw
```

The `refork/<date>` scratch branches are kept until the user explicitly deletes them.

## Notes

- This skill never runs `codex` automatically. The user invokes it if they want a second opinion on the classifications.
- The plan file is the source of truth. The Execution log inside it is append-only — never rewrite history in the plan.
- If at any point the diff stops matching the plan (e.g. a "rebase" commit suddenly conflicts heavily), stop and re-classify with the user. Don't silently switch to reimplement mid-run.
