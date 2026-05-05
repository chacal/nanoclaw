# Fork notes (chacal/nanoclaw)

This is a personal fork of [`qwibitai/nanoclaw`](https://github.com/qwibitai/nanoclaw).
Upstream's docs and `CLAUDE.md` describe the upstream codebase; this file
describes what's different here. Read it before assuming upstream defaults.

## What this fork adds (user-facing)

Fork-specific capabilities, in non-technical terms. Mechanics for each are
documented in the sections below.

- **"Pentti" persona** — a household-assistant identity layered into every
  session via `groups/global/SOUL.md`, with optional per-group role overrides
  (e.g. study helper, admin) via `groups/<name>/SOUL.md`.
- **Multi-user family install** — distinct groups for individual family
  members and shared spaces: `signal_jouni`, `signal_oona`, `signal_kouluapu`
  (kids' homework), `signal_perhe` (whole family), `telegram_pentti`. Each
  has its own memory, persona overlay, and trigger config.
- **Smart home control (Home Assistant)** — Pentti can query and control the
  household HA instance (lights, sensors, automations) via the `ha-api`
  shim. Scoped to a restricted HA user.
- **Math / factual queries (Wolfram Alpha)** — Pentti can answer
  computational, scientific, and factual lookups via the Wolfram skill + shim.
- **Google Workspace (Gmail / Calendar / Drive)** — Pentti can read/search
  Gmail, look at calendar events, and access Drive on behalf of the household
  via the `gws` CLI.
- **External event webhooks** — a separate `POST /api/webhook` endpoint lets
  external systems (notably Home Assistant automations) inject messages and
  wake Pentti, so Pentti can proactively notify the family when something
  happens at home, not just respond to chat.
- **Signal as a first-class channel** — beyond bare upstream Signal: proper
  @mention name display in replies, mention-aware "directed at me" detection,
  inline image attachments handled correctly, and an echo-cache fix so
  Pentti's own messages don't loop. Telegram is wired but used as-is.
- **Per-group model selection** — each group can run on a different Claude
  model / thinking budget / small-model fallback via `container.json`.
  Cheaper models for low-stakes groups, heavier reasoning where it matters.

## Branch model (hybrid main/base/custom)

| Branch | Tracks | Contents |
|--------|--------|----------|
| `main` | `upstream/main` | Mirror of v2 upstream. Fast-forward only. |
| `base` | `main` + skill-equivalent foundation | Channel skills (`/add-signal`, `/add-telegram`) applied as plain commits. Skill *branches* that still merge cleanly into v2 (if any) land here as merge commits. |
| `custom` | `base` + linear features | Fork-local features as atomic commits. |

Discipline rule: before any merge into `custom`, stop. Skill or upstream
fork → goes onto `base`. Our feature → linear commit on `custom`.

Upstream pull workflow:
- Minor version bumps: `/update-nanoclaw` skill.
- Major version (e.g. v2 → v3): `/migrate-nanoclaw` Tier 3 (clean-base replay
  in a `.upgrade-worktree/`, not a merge). The cleaned v1 → v2 migration
  summary lives at `docs/migration-2026-05.md`; the full audit trail is kept
  on `archive/custom-pre-cleanup-2026-05-05`.

## Credential management — OneCLI Agent Vault

Adopted from upstream. The fork previously ran a native credential proxy
(`src/credential-proxy.ts`); during the v1 → v2 migration on 2026-05-01 the
proxy was retired in favor of OneCLI because the `skill/native-credential-proxy`
branch had drifted 720 commits behind v2 main and the maintenance cost of
swimming against upstream's OneCLI-first architecture (`ensureAgent`,
`agent_groups.agent_provider`, approval flows) outweighed the in-process
simplicity gain.

Operational notes:
- On install: run `/init-onecli` to migrate `.env` credentials into the vault.
- **Gotcha** (also documented in upstream `CLAUDE.md`): auto-created agents
  start in `selective` secret mode and silently 401. Run
  `onecli agents set-secret-mode --id <agent-id> --mode all` per agent group,
  or use the web UI at `http://127.0.0.1:10254`.
- HA token: scope to a restricted Home Assistant user. Scoping moved from
  the proxy's path-allowlist layer to OneCLI host-pattern + identity layer.
- Wolfram appid: low-value query-param secret. OneCLI's header-only injection
  doesn't cover query params; the appid is baked into `WOLFRAM_APP_ID` and
  the `wolfram-alpha` shim invokes it directly.

## External HTTP API

`src/external-api.ts` listens on `EXTERNAL_API_PORT` (default 3002, separate
from upstream's `WEBHOOK_PORT` Chat-SDK adapter callback server).

- Single endpoint: `POST /api/webhook`. **No `/voice`** (dropped during v2
  migration; voice continues to work on Signal + Telegram channels via
  in-band transcription). **No `/api/message`** (built originally for
  iPhone-dictation; never used).
- Token store: `~/.config/nanoclaw/api-tokens.json` (mode 0600, outside the
  project root, never mounted into containers). Shape:
  `{ "tokens": [{ "token": "...", "userId": "...", "platformId": "...", "displayName": "..." }] }`.
  `loadApiTokens()` rejects a top-level array.
  - `userId` is a v2-namespaced identity (e.g. `phone:+358xxx` for owner-trust
    tokens, `api:hass` for synthetic webhook senders).
  - `platformId` binds to a wired `messaging_groups(channel_type='api',
    platform_id=<this>)` row in `data/v2.db`.
- Identity model: requests flow through a synthetic `'api'` channel adapter
  (`src/channels/api.ts`) into v2's standard `routeInbound` pipeline →
  `senderResolver` → `accessGate` → `command-gate`. Trust comes from
  `user_roles`; there is no `isFromMe` shim. Owner-trust tokens map to a real
  v2 user row that carries an `owner` role; HA-style tokens use synthetic
  user ids with `agent_group_members` membership only.
- Validation is strict: malformed JSON, non-object body, or missing token
  fields returns 4xx without crashing the server. `loadApiTokens()` rejects
  v1-shape entries (`{sender, senderName, isFromMe}`) so the API channel
  refuses to start until tokens are migrated to the v2 shape.
- Per-token wiring is required before the first webhook lands: insert
  `messaging_groups` + `messaging_group_agents` + (for synthetic users)
  `users` + `agent_group_members` rows.
- Bind host: `EXTERNAL_API_HOST` defaults to `127.0.0.1` so bearer tokens do
  not travel cleartext over the LAN unless the operator explicitly binds a
  LAN interface and terminates TLS upstream.

## Host integrations (install-wide)

`src/host-integrations.ts` contributes mounts + env vars to every container
spawn based on host configuration. **All three integrations below are
install-wide capabilities** — every agent group on this install gets them
when the host is configured. The credential boundary lives at the OneCLI
per-agent secret-mode level (run `onecli agents set-secret-mode` to scope
which secrets each agent can see); per-group gating in `container.json`
(`hostIntegrations: ['gws', 'ha', 'wolfram']`) is a post-cutover policy
decision and is intentionally not implemented yet.

| Integration | Trigger | Container surface |
|-------------|---------|-------------------|
| Google Workspace CLI (`gws`) | `~/.config/gws/credentials.enc` + `.encryption_key` exist on host | RW mount of `~/.config/gws` → `/workspace/gws-config`; env `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` + `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file`. CLI installed in the agent image. |
| Home Assistant (`ha-api`) | `HA_BASE_URL` set in `.env` | Env `HA_BASE_URL` injected; `container/ha-api.sh` shim calls `${HA_BASE_URL}/api/...` directly. Authorization comes from OneCLI host-pattern injection on the matching host (configured at cutover). |
| Wolfram Alpha (`wolfram-alpha`) | `WOLFRAM_APP_ID` set in `.env` | Env `WOLFRAM_APP_ID` injected; `container/wolfram-alpha.sh` + `container/skills/wolfram-alpha/` skill installed. The shim calls `api.wolframalpha.com` with the appid as a query param. |

Belt-and-braces: gws requires both `credentials.enc` and `.encryption_key`;
mounting just one would let the container write into a dir it can't decrypt
and corrupt host state.

## Channels

| Channel | Status | Fork delta vs upstream |
|---------|--------|------------------------|
| Signal | Primary | `prefillNameCache()` for mention-name resolution; echo-cache key fix (Codex Stage A finding); outbound text-styles (`parseSignalStyles`) for Markdown → JSON-RPC textStyle ranges. Applied **post-cutover** as small atomic commits (live-traffic validation is higher-signal than worktree dry-runs). |
| Telegram | Used as-is | Upstream's `/add-telegram` skill (`@chat-adapter/telegram` Chat-SDK bridge). No fork customizations — see personal-use minimization preference. |
| WhatsApp | Not applied | Intentionally absent on this fork. |

## Container — per-group runtime config

Per-group overrides live in `groups/<folder>/container.json`. The fork extends
the upstream config schema with optional model overrides:

| Field | Effect |
|-------|--------|
| `model` | Default Claude model for spawns from this group. |
| `thinkingBudget` | Per-group thinking budget. |
| `smallModelId` | Override for Claude Code's small-model fallback. |
| `taskModel` | Accepted for v1 config compatibility but **currently inactive**. Enabling per-spawn task-model selection requires threading the scheduled-task wake context through `host-sweep`/`container-runner`; v2's wake path doesn't carry an `isScheduledTask` signal today. Keeping the field on `ContainerConfig` lets v1 group records carry forward without loss. |

The host writes the resulting `~/.claude/settings.json` inside the group's
`.claude-shared/` directory at every spawn via `composeClaudeSettings` /
`regenerateClaudeSettings`. **Merge contract:** unrelated user fields
(permissions, plugin marketplace, manual model fallback) are preserved
verbatim. Host env defaults are added under existing env (user wins);
`container.json` model / thinkingBudget / smallModelId override when set,
preserve existing when unset. Stage E codex review caught the original
unconditional rewrite; the merge was a deliberate behavior change vs v1's
"settings.json is regenerated, manual edits get clobbered" contract.

## Prompt stack: layered persona + memory

The container's effective system prompt is composed at every spawn from
five layers, in this order:

1. **Upstream `container/CLAUDE.md`** — bind-mounted RO at `/app/CLAUDE.md`.
   Generic agent operational guidance (workspace, memory rules, communication).
   We don't patch this file (avoids upstream merge conflicts); fork-local
   content lives in the SOUL slots below.
2. **Skill / module / MCP fragments** — under `.claude-fragments/`,
   alphabetically sorted. Built-in (e.g. `module-schedule_task.md`) plus any
   MCP-server `instructions` from `container.json`.
3. **Global persona** (`groups/global/SOUL.md`) — emitted as
   `.claude-fragments/zz-global-soul.md` into every group's compose. The
   install-wide identity ("You are Pentti, a trusted family assistant…").
   Sorts after fragments because of the `zz-` prefix.
4. **Per-group memory** (`groups/<folder>/CLAUDE.local.md`) — auto-loaded
   by the Claude Code SDK using its standard convention. Two writers:
   the agent (auto-memory tool) and the human. CLAUDE.local.md is the
   index — durable always-relevant notes go here, larger/growing memory
   goes in dedicated topic files (`MEMORY.md`, `people.md`, `home.md`,
   `projects.md`) referenced from the index.
5. **Per-group persona override** (`groups/<folder>/SOUL.md`) — emitted
   as `.claude-fragments/zzz-group-soul.md`. Optional. Use this when a
   particular group needs a role layered on top of the global identity
   ("Pentti as study helper", "Pentti as admin"). Sorts last because of
   the `zzz-` prefix.

`groups/<folder>/CLAUDE.md` is **regenerated every spawn** by
`composeGroupClaudeMd` in `src/claude-md-compose.ts` — it is just
`@-imports` plus a header. Don't hand-edit it; changes are clobbered on
next message.

Both SOUL.md files are human-owned. The agent's auto-memory tool does
not write to them — it only writes to `CLAUDE.local.md`. So persona stays
stable across sessions even when memory rotates.

Fork-local source: the global SOUL slot and the `groups/global/`-preservation
in `migrateGroupsToClaudeLocal` are fork-local extensions of upstream's
compose. Upstream removed `groups/global/` entirely at v2 first boot
(claiming "content already in `container/CLAUDE.md`"); we preserve it as
the canonical home for `groups/global/SOUL.md`.

## Multi-group install

The fork runs as a shared install for several trusted family users. Each
registered messaging group has its own `groups/<name>/` folder with
`CLAUDE.md` (and optional `SOUL.md`), independent trigger configuration,
independent provider config. Adding a new user: register their chat via the
main channel with the appropriate trigger mode, copy any per-user MCP
overrides, restart the service.

## Backup script

`backup.sh` at the project root is rsync-with-hardlinks dedup. It backs up
everything that isn't tracked in git and isn't regenerated.

External paths included:
- `~/.local/share/signal-cli` — Signal identity & encryption keys
- `~/.config/nanoclaw` — mount/sender allowlists + `api-tokens.json`
- `~/.config/gws` — Google Workspace CLI encrypted creds + AES key
- `~/.ssh/nanoclaw_deploy[.pub]` — GitHub deploy keys
- `~/.claude/plans` and the per-project Claude Code memory dir

Project-side excludes target v2 paths: `data/v2-sessions/*/.claude-shared/`
session artifacts, composed CLAUDE.md / `.claude-fragments/`, build output,
`logs/`. The central DB (`data/v2.db`) and the per-session `inbound.db` /
`outbound.db` files **are** backed up — they hold message state.

Run manually or via systemd timer: `./backup.sh`. Backups land under
`~/nanoclaw-backups/<timestamp>/`. Retention: last 7.

## Service management (Linux)

systemd user service: `systemctl --user start|stop|restart|status nanoclaw`.
Logs: `journalctl --user -u nanoclaw -f`. Idle container timeout: 4 hours
(`IDLE_TIMEOUT=14400000`).

## Migration history

- v1.2.53 → v2 migration completed in May 2026. The cleaned branch keeps
  durable customizations as replayable commits and replaces migration-process
  notes with `docs/migration-2026-05.md`. The full pre-cleanup audit trail is
  available at `archive/custom-pre-cleanup-2026-05-05`.
- Pre-migration safety tags: `backup/pre-hybrid-surgery`,
  `backup/pre-replay-main`, `backup/pre-v2-migration-43fad29-*`.
- `backup/old-main` (pre-v1.2.53 mirror) on local + origin.

## Open items (post-cutover policy)

These are intentionally deferred to post-cutover as policy decisions, not
implementation gaps:

- Per-group `container.json.hostIntegrations: [...]` gate so groups can opt
  out of gws / HA / Wolfram contributions individually.
- Threading `isScheduledTask` through `host-sweep`/`container-runner` so
  `taskModel` becomes effective.
- `parseInt(EXTERNAL_API_PORT)` NaN/range guard (5-line nice-to-have).
