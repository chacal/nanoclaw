# Fork notes (chacal/nanoclaw)

Personal fork of [`nanocoai/nanoclaw`](https://github.com/nanocoai/nanoclaw)
for one household. Upstream's `CLAUDE.md` and `docs/` describe upstream; this
file describes what is different here. Read it before you assume upstream
defaults.

**Design rule (since the 2026-11-21 refork): keep the fork diff minimal.**
A feature is fork *code* only when upstream has no seam for it. Everything
else is install state (`groups/`, the central DB, the OneCLI vault, `.env`)
or an own new file that cannot conflict on merge.

## What the household gets

| Feature | How it is done | Fork code? |
|---|---|---|
| "Pentti" persona, per-group roles | `groups/<folder>/instructions.prepend.md` (upstream slot, first section, never dropped) | No — install state |
| Five agent groups: **Pentti** (Jouni's DM on Signal *and* Telegram, one `agent-shared` conversation, folder `signal_jouni`), Oona, Venla, Kouluapu, Perhe | Upstream agent groups + wiring (two messaging groups → one agent group) | No |
| Model (all groups: Claude Opus 5.5) | `NANOCLAW_DEFAULT_MODEL` in `.env` (per group: `ncl groups config update --model`) | No |
| Home Assistant read/control | `container/skills/home-assistant/` (skill + `ha-api` script); token injected by OneCLI | Own new files |
| Wolfram Alpha (all groups) | `container/skills/wolfram-alpha/` (skill + script); appid injected by OneCLI as a query param | Own new files |
| Google (calendar, mail, drive) | OneCLI Google app connection, granted per agent | No |
| Todoist | `@doist/todoist-mcp` as a per-group MCP server; token from the vault | No — container config |
| Morning brief when Jouni wakes up | Scheduled task with a gate script that polls an HA helper | No — task in DB |
| Signal: inbound images, mention names, decode-failure log | Patch in the installed `src/channels/signal.ts` | **Yes** |
| Signal: Markdown → text styles (`_` inside words, code spans, fenced blocks and `\_` escapes survive) | Own file `src/channels/signal-styles.ts` (CommonMark rules, no dependency) + one import line in `signal.ts` replacing the upstream regex converter | **Yes** |
| Sender display names in the agent prompt (Kouluapu twins) | Patch in `container/agent-runner/src/formatter.ts` (upstream #3858) | **Yes** |
| Telegram | Upstream `/add-telegram`, unchanged | No |
| Voice questions from Jouni's iPhone (Siri Shortcut "Kysymys Pentille") | Upstream `/add-emacs` HTTP channel wired to Pentti + LAN socket proxy + rules in Pentti's prepend (see below) | No |

The **Yes** rows are the whole core diff: Signal adapter changes and the
formatter patch. All are PR candidates (upstream's `channels` branch still has
the regex converter that broke `sensor.iphone_15_pro_max_battery_state`); open
nothing upstream without Jouni's approval.

## Branch model

| Branch | Contents |
|---|---|
| `main` | Mirror of upstream (release tags). Fast-forward only. |
| `base` | `main` + skill installs as plain commits (`/add-onecli`, `/add-signal`, `/add-telegram`). |
| `custom` | `base` + the fork commits (Signal patch, formatter patch, skills, docs). |

Updating — **do not use `/update-nanoclaw` while the Signal patch exists.**
Its validation step re-copies every installed channel from the `channels`
branch (dropping the Signal patch) and then runs the full host tests; the
fork's Signal tests then fail and the update rolls back. Use a light replay
instead (the `/refork` skill describes the full version):

1. Worktree on the new release tag; apply the code directives of
   `/add-onecli`, `/add-signal`, `/add-telegram` (= new `base`).
2. Re-apply the fork commits on top (`git cherry-pick base..custom`; the
   Signal commits are small and separate, so conflicts stay local).
3. Gates (build, tsc, host + container tests, `./container/build.sh`), then
   the gated switchover: back up branches, move `main`/`base`/`custom`,
   stamp the upgrade state, restart, `docs/manual-test-checklist.md`.

Once upstream has the Signal fixes (PR candidates, need Jouni's approval),
drop those commits and `/update-nanoclaw` works again.

Local-only ignore rules (`coverage/`, `.codex*`, `.claude/settings.local.json`,
`.upgrade-worktree/`, …) live in `.git/info/exclude`, not `.gitignore`, to
keep the diff zero. The pointer to this file for Claude Code sessions is the
untracked root `CLAUDE.local.md`.

**Upgrade tripwire:** `data/upgrade-state.json` records the exact commit and
tree. After **every** commit on the live checkout (even docs-only) run
`pnpm exec tsx scripts/upgrade-state.ts set`, or the next restart crash-loops.

## Jouni's DMs: one agent, two apps

Since 2026-11-21 the Signal DM (`mg-1777836132384-bhe11c`) and the Telegram DM
(`mg-1777836132385-cpa3ld`) are both wired to agent group **Pentti**
(`ag-1777836132384-mvh0sn`, folder `signal_jouni`, formerly "Jouni Signal") with
`session_mode: agent-shared`: one conversation, replies go to the chat the
message came from. The agent's send destinations are `jouni-signal` and
`jouni-telegram` (named after the person reached, not the agent); scheduled
reports name `jouni-signal` explicitly. The old Telegram agent group `ag-1777836132385-0utg0i`
("Pentti Telegram (archived)", `groups/telegram_pentti`) has no wiring and no
OneCLI grants; its notes were merged into `signal_jouni`.

## Voice questions (iPhone Shortcut)

Since 2026-11-22. "Hei Siri, kysymys Pentille" → Siri asks for the question →
the Shortcut sends it to Pentti and Siri speaks the answer. Siri gives up
after ~30 s, so the Shortcut stops waiting at ~25 s.

- **Transport:** the upstream Emacs channel (`/add-emacs`, a plain commit on
  `base`). It is a small HTTP bridge: `POST /api/message {"text"}` returns a
  ms `timestamp`; `GET /api/messages?since=<timestamp>` returns the replies.
  Bearer token. `.env`: `EMACS_ENABLED`, `EMACS_CHANNEL_PORT=8766`,
  `EMACS_AUTH_TOKEN` (also in the Shortcut), `EMACS_PLATFORM_ID=iphone-voice`.
  It listens on `127.0.0.1` only.
- **Network:** user units `~/.config/systemd/user/pentti-voice-proxy.{socket,service}`
  (`systemd-socket-proxyd`, no package) listen on `10.50.100.12:8767` and
  forward to `127.0.0.1:8766`. The phone reaches it over the home VPN.
  Plain HTTP inside the VPN; the token is the access control.
- **Wiring:** messaging group "Jouni iPhone voice" (`emacs`, `iphone-voice`)
  → Pentti, `agent-shared` (same conversation as Signal/Telegram). Sender
  user `emacs:iphone-voice` is a member of Pentti.
- **Behaviour:** section "Voice questions from Jouni's iPhone" in
  `groups/signal_jouni/instructions.prepend.md`: one message, one or two plain
  sentences, `wiki/private/` may be spoken, longer details to `jouni-signal`.
  On timeout the Shortcut sends "(Aikakatkaisu: lähetä vastaus Signaliin.)"
  and Pentti sends the answer to `jouni-signal`.
- **Measured:** 4.7–6.6 s per vault question, cold start included.
- **Remove:** `systemctl --user disable --now pentti-voice-proxy.socket`,
  set `EMACS_ENABLED=false`, delete the wiring/messaging group.

## Persona

Master copy: `groups/global/SOUL.md` (shared) and `groups/<folder>/SOUL.md`
(optional per-group role). NanoClaw 2026.11 reads neither. What it reads is
`groups/<folder>/instructions.prepend.md`. After you edit a SOUL file,
regenerate the prepend files:

```bash
cd ~/nanoclaw/groups
for g in signal_jouni signal_kouluapu signal_oona signal_perhe signal_venla; do
  { cat global/SOUL.md; [ -f $g/SOUL.md ] && { printf '\n\n'; cat $g/SOUL.md; }; } > $g/instructions.prepend.md
done
```

**Exception — do not regenerate `signal_jouni` with this loop.** Pentti's
prepend has edits that are in no master (the Telegram list rule, the vault
section, the voice section); there is no `groups/signal_jouni/SOUL.md`.
Edit that prepend file directly, or move those sections into a
`signal_jouni/SOUL.md` master first.

Changes apply at the next container start. The group folder is agent-writable,
so an agent can edit its own prepend file; the SOUL masters are the reference.

## Credentials — OneCLI

- Gateway pin and CLI pin: `.claude/skills/add-onecli/versions.json`. The
  gateway version is saved as `ONECLI_VERSION` in `~/.onecli/.env`; the compose
  image line reads it. Follow `docs/onecli-upgrades.md` for every move.
- Since gateway 1.44: **grants, not secret modes.** An agent gets only the
  secrets attached to it: `onecli agents grants list|attach-secret|detach-secret`.
  New groups get only their model key, which NanoClaw finds by the secret name
  `Anthropic`.
- `~/.onecli/.env` holds `POSTGRES_PASSWORD` (GHSA-j39m); never mount `~/.onecli`.
- Ops guard (Ansible, `nanoclaw-agent-guard.service`): docker0 → 172.17.0.1
  :10254 and :5432 rejected; :10255 (proxy) open. Tell ops before any change to
  OneCLI ports, bind address or networks.
- The proxy overwrites an existing `Authorization` header and injects query
  params (Wolfram `appid`). A non-granted agent gets 401 (Wolfram answers 400).
- `~/.onecli/docker-compose.yml` sets `APP_URL`/`NEXT_PUBLIC_APP_URL` to
  `http://localhost:10254`: Google OAuth accepts a plain-http redirect only for
  localhost. Open the dashboard through `ssh -L 10254:172.17.0.1:10254 claw`.
  Side effect: the app then reports the approval-poll address as
  `localhost:10255`, where nothing listens on the host, so held requests
  ("ask" grants) time out with no log line. The fix is the systemd drop-in
  `~/.config/systemd/user/nanoclaw-v2-c8d7084f.service.d/onecli-gateway-url.conf`
  (`ONECLI_GATEWAY_URL=http://172.17.0.1:10255`). Keep both together.

### Google (since 2026-11-21)

OneCLI app connections, own OAuth client ("OneCLI", Web application, in the
old gws Google Cloud project, app published, unverified). Every Google app has
its own redirect URI: `http://localhost:10254/v1/apps/<app-id>/callback`
(`gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-sheets`,
`google-slides`, `google-contacts`, …). Grants:

| Account | Agents | Access |
|---|---|---|
| pentti.bot@gmail.com | Pentti (Jouni's DMs) | full (7 apps) |
| pentti.bot@gmail.com | Kouluapu, Perhe, Oona Signal, Venla Signal | full, except Gmail `send_email`/`send_draft` = ask (approval card to the owner, in Telegram) |
| jhartikainen@gmail.com | Pentti (Jouni's DMs) only | read tools only (7 apps) |

Pentti (Jouni's DMs) has two accounts per app: the agent picks one with the header
`x-onecli-connection-id` (IDs in `groups/signal_jouni/CLAUDE.local.md`).
Read effective access with `onecli apps connections agent-access --id <connection>`.

### Adding a credentialed tool (MCP server recipe)

1. `onecli secrets create …`, then check `onecli secrets list` that the
   injection config is set (CLI 2.2.5 dropped `--header-name` on create; verify
   on newer CLIs too).
2. `ncl groups config add-package --id <group> --npm <pkg>@<exact-version>`
   (no `minimumReleaseAge` gate on this path: check the publish date and that
   the package has no install scripts).
3. `ncl groups config add-mcp-server --id <group> --name <n> --command <bin>
   --env '{"<TOKEN_VAR>":"placeholder"}'` (or `--url` for an HTTP server).
4. `onecli agents grants attach-secret --id <agent-id> --secret-id <id>` for
   each group that may use it.
5. `ncl groups restart --id <group>`; check that granted groups work and the
   others get 401 (or the API's own "no key" error, e.g. Wolfram 400).

### Secrets per agent (OneCLI grants)

| Agent | Secrets |
|---|---|
| Pentti (Jouni's DMs) | Anthropic, Home Assistant, Todoist, Wolfram Alpha |
| Kouluapu, Perhe, Oona Signal, Venla Signal | Anthropic, Home Assistant, Wolfram Alpha |
| Pentti Telegram (archived), Default Agent | none |

Todoist is also the only per-group MCP server (Pentti only).

## Install-state levers (not in git)

| Lever | Where | What it does |
|---|---|---|
| `NANOCLAW_DEFAULT_MODEL=claude-opus-5-5` | `.env` | Model for every group without its own `--model` |
| `NANOCLAW_GATEWAY_PROVIDER=onecli` | `.env` | Explicit gateway choice (only one is installed) |
| `SIGNAL_CLI_PATH` | `.env` | JRE signal-cli wrapper (see below) |
| `OPENAI_API_KEY` | `.env` | Used by upstream's Signal adapter for Whisper voice transcription (host-side, never in a container) |
| `ONECLI_GATEWAY_URL` | systemd drop-in | Approval-poll address (see Credentials) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `data/v2-sessions/ag-1777836132384-mvh0sn/.claude-shared/settings.json` (`env`) | Larger compaction window for Pentti |
| Persona | `groups/*/instructions.prepend.md` | See Persona |
| Memory | `groups/*/CLAUDE.local.md`, `MEMORY.md`, topic files | Root `CLAUDE.local.md`/`MEMORY.md` in `signal_jouni` and `signal_kouluapu` are deliberate. Upstream `/migrate-memory` would treat them as legacy: do not run it without checking first |
| Scheduled tasks | central DB (`ncl tasks list`) | Morning wake gate, 09:15 fallback brief, 15:00 heating report, weekly drill-deal check |

## Signal runtime: JRE signal-cli

The daemon must run the **JRE build** of signal-cli: the native build cannot
load AWT/ImageIO, so outbound image attachments fail.

- `.env`: `SIGNAL_CLI_PATH=/home/jihartik/.local/share/signal-cli-jre/run-signal-cli.sh`
- The wrapper pins a user-local Temurin 25 JRE (`~/.local/share/temurin-25-jre`).
- Version 0.14.9 since 2026-11-21. Upgrade by replacing `bin/ lib/ man/` in
  `~/.local/share/signal-cli-jre/` (keep the wrapper) while the service is
  stopped; check the jar class version against the JRE first.
  `setup/install-signal-cli.sh` installs the native build and does not help here.

## Service (Linux)

The unit is `nanoclaw-v2-c8d7084f.service` (`nanoclaw-v2-<slug>`, slug = first 8
chars of sha1 of the project path), renamed from `nanoclaw.service` on
2026-11-25 so upstream tooling finds it. Before the rename `setup/lib/restart.sh`
answered "no installed service". The unit file and its OneCLI drop-in
directory live in `~/.config/systemd/user/`.

The unit runs `dist/index.js`, so **build first** (`pnpm run build`); then
`bash setup/lib/restart.sh` (restarts and waits until the new host answers) or
`systemctl --user start|stop|restart|status nanoclaw-v2-c8d7084f`. Logs in
`logs/nanoclaw.log` and `logs/nanoclaw.error.log`. `KillMode=process`: check the
port owner after a restart (normally nothing listens on :3000 now). Stamp the
upgrade state after any upgrade, branch flip or commit (see Branch model).

## Removed in the 2026-11-21 refork

External webhook API (`/webhook/api`, `api-tokens.json`), host integrations
code and the gws mount, SOUL compose patch, `backup.sh` (the VM disk is backed
up), the Telegram unescape fix (upstream adapter 4.41 renders MarkdownV2), the
Claude Code version bump. Details and reasons: `docs/refork-2026-11-21.md`.

## History

- 2026-11-21: refork onto 2026.11.0 with a minimal-diff review
  (`docs/refork-2026-11-21.md`).
- 2026-08-15: refork onto upstream main (`docs/refork-2026-08-15.md`).
- 2026-05: v1 → v2 migration (`docs/migration-2026-05.md`).
- Old histories before the 2026-11-21 rewrite: `archive/custom-2026-10-18`
  (the previous `custom`, 8a73c98e) and `archive/base-2026-08-15` (955094a4),
  pushed to `origin`. Older commit hashes named in commit messages and docs
  (e007c042, 8a73c98e, 4a0bd406, 3adaef49, …) live there.
