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
- **Todoist tasks** — Pentti can read, add, and complete tasks on Jouni's
  Todoist account via the official `@doist/todoist-mcp` server. Unlike the
  integrations above this is **not** install-wide: it is wired only to the
  `Jouni Signal` and `Pentti` agent groups, and the other three groups are
  provably locked out at the vault. See "MCP servers with vault credentials".
- **External event webhooks** — a `POST /webhook/api` endpoint (on the shared
  webhook server) lets external systems (notably Home Assistant automations)
  inject messages and wake Pentti, so Pentti can proactively notify the family
  when something happens at home, not just respond to chat.
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
- **Gotcha** (verified 2026-08-16 on `onecli-cli` 2.2.5): agents are created in
  **`all`** secret mode, not `selective` — both by `ensureAgent` at spawn and by
  `onecli agents create`. This doc previously claimed the opposite, which is the
  more dangerous way to be wrong: a new agent group silently inherits *every*
  host-pattern-matching secret in the vault the first time it spawns. To restrict
  one, `onecli agents set-secrets --id <agent-id> --secret-ids <ids>` (which flips
  it to `selective` atomically, so there is no credential-less window), or use the
  web UI at `http://127.0.0.1:10254`.
- **Gotcha** (`onecli-cli` 2.2.5): `onecli secrets create` silently *drops*
  `--header-name` / `--value-format` — the secret is created with
  `injectionConfig: null` and injects nothing, with no error. Always follow a
  create with `onecli secrets update --id <id> --header-name … --value-format …`
  and confirm via `onecli secrets list` that `injectionConfig` is populated.
- HA token: scope to a restricted Home Assistant user. Scoping moved from
  the proxy's path-allowlist layer to OneCLI host-pattern + identity layer.
- Wolfram appid: **migrated into the vault 2026-08-16** as secret
  `Wolfram Alpha` (generic, host pattern `api.wolframalpha.com`,
  `paramName: appid`), using OneCLI's query-parameter injection. The
  `WOLFRAM_APP_ID` env var is gone and the shim sends no appid — the gateway
  appends it. A regression test in `src/host-integrations.test.ts` fails if the
  appid ever reappears in the container env.

## External HTTP API

`src/external-api.ts` exports a raw-route handler mounted on upstream's
shared webhook server (`src/webhook-server.ts`, `registerWebhookHandler`) —
one server, one port (`WEBHOOK_PORT`, default 3000, binds `0.0.0.0`).
The pre-refork standalone server on `EXTERNAL_API_PORT`/`EXTERNAL_API_HOST`
(default 3002) is gone; those env vars are dead.

- Single endpoint: `POST /webhook/api`. **No `/voice`** (dropped during v2
  migration; voice continues to work on Signal + Telegram channels via
  in-band transcription). **No `/api/message`** (built originally for
  iPhone-dictation; never used).
- Token store: `~/.config/nanoclaw/api-tokens.json` (mode 0600, outside the
  project root, never mounted into containers). Shape:
  `{ "tokens": [{ "token": "...", "userId": "...", "platformId": "...", "displayName": "..." }] }`.
  `loadApiTokens()` rejects a top-level array.
  - `userId` is a v2-namespaced identity (e.g. `phone:+358xxx` for owner-trust
    tokens, `api:hass` for synthetic webhook senders).
  - `platformId` binds to a wired `messaging_groups` row in `data/v2.db` —
    but note the runtime normalizes it through `namespacedPlatformId('api', …)`
    before routing, so the DB row must carry the prefix:
    `channel_type='api', platform_id='api:<token platformId>'` (e.g. token
    `"hass-main"` → row `api:hass-main`). A token whose platformId already
    starts with `api:` passes through unchanged. Wiring the bare value is the
    classic miss — webhooks then route past the intended row and trigger the
    channel-approval card instead (migration quirk #11).
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
- Bind host: the shared webhook server binds `0.0.0.0` (LAN-reachable, which
  Home Assistant on a separate host needs). Bearer-token auth is the trust
  boundary on the wire; TLS must still be terminated upstream — the server
  speaks plain HTTP.

## Host integrations (install-wide)

`src/host-integrations.ts` contributes mounts + env vars to every container
spawn based on host configuration. **Both integrations below are
install-wide capabilities** — every agent group on this install gets them
when the host is configured. The credential boundary lives at the OneCLI
per-agent secret-mode level (`onecli agents set-secrets` to scope which
secrets each agent can see); per-group gating in `container.json`
(`hostIntegrations: ['gws', 'ha']`) remains unimplemented.

Note that the secret-mode lever is no longer purely theoretical: as of
2026-08-16 it is load-bearing for Todoist (see below), and three agents
(`Kouluapu`, `Perhe`, `Oona Signal`) run in `selective` mode holding only
the Anthropic and HA secrets. **Adding a vault secret no longer grants it
to every group** — a new secret reaches only the `all`-mode agents
(`Jouni Signal`, `Pentti`) unless explicitly assigned to the others.

| Integration | Trigger | Container surface |
|-------------|---------|-------------------|
| Google Workspace CLI (`gws`) | `~/.config/gws/credentials.enc` + `.encryption_key` exist on host | RW mount of `~/.config/gws` → `/workspace/gws-config`; env `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` + `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file`. CLI installed in the agent image. |
| Home Assistant (`ha-api`) | `HA_BASE_URL` set in `.env` | Env `HA_BASE_URL` injected; `container/ha-api.sh` shim calls `${HA_BASE_URL}/api/...` directly. Authorization comes from OneCLI host-pattern injection on the matching host (configured at cutover). |

Wolfram Alpha used to be a third row here. Since 2026-08-16 it contributes
nothing to the container spawn: the shim and skill are unconditionally in the
image, and the appid is a query-param-injecting vault secret. It is documented
under the next section instead.

Belt-and-braces: gws requires both `credentials.enc` and `.encryption_key`;
mounting just one would let the container write into a dir it can't decrypt
and corrupt host state.

## MCP servers with vault credentials (per-group)

A third integration shape, distinct from the shims above and **preferred for
anything new**. The shims exist because this fork grew them before the
upstream pattern was understood; they cost fork-local code
(`container/*.sh` + a Dockerfile line + a skill) that must be carried across
every upstream pull. An MCP server costs *zero* code — it is pure config in
`container_configs`, and it is per-group by construction.

The mechanism: OneCLI installs `HTTPS_PROXY` + CA certs into every container
(`src/container-runner.ts`, `applyContainerConfig`), so **all** container
egress is intercepted — including an MCP server's own HTTP client. The
credential is matched by API host and injected at the proxy boundary. This is
upstream's documented model; see `docs/templates.md` § "MCP servers and
credentials".

Two behaviours verified empirically on 2026-08-16, both of which the design
depends on and neither of which is stated outright upstream:

1. The proxy **overwrites** an existing `Authorization` header; it does not
   merely fill in a missing one. This is what makes the `"placeholder"` env
   convention work for servers that refuse to boot without a token set.
2. `selective`-mode agents genuinely cannot reach a secret they are not
   assigned — the proxy returns 401 rather than injecting.

Todoist is the first instance:

| Piece | Value |
|-------|-------|
| Vault secret | `Todoist`, type `generic`, host pattern `api.todoist.com`, injects `Authorization: Bearer {value}` |
| Package | `@doist/todoist-mcp`, pinned, added via `ncl groups config add-package --npm` |
| MCP server | name `todoist`, `command: todoist-mcp`, `env: {"TODOIST_API_KEY":"placeholder"}` |
| Groups | `Jouni Signal`, `Pentti` only (`ag-1777836132384-mvh0sn`, `ag-1777836132385-0utg0i`) |
| Isolation | `Kouluapu` / `Perhe` / `Oona Signal` are `selective` and unassigned → 401 |

Recipe for the next one:

1. `onecli secrets create …` then `onecli secrets update …` to set the
   injection config (create drops it — see Operational notes above).
2. `ncl groups config add-package --id <group> --npm <pkg>@<exact-version>`.
   Pin explicitly: this path builds a derived image with `pnpm install -g` and
   does **not** enforce the repo's `minimumReleaseAge` gate, so check the npm
   publish date by hand. It also auto-appends the package to
   `only-built-dependencies`, so confirm the package has no
   `preinstall`/`install`/`postinstall` script before adding it.
3. `ncl groups config add-mcp-server --id <group> --name <n> --command <bin>
   --env '{"<TOKEN_VAR>":"placeholder"}'`.
4. `ncl groups restart --id <group> --rebuild` for each group.
5. Verify isolation, not just function: confirm the intended groups reach the
   API *and* that the excluded ones get 401.

## Channels

| Channel | Status | Fork delta vs upstream |
|---------|--------|------------------------|
| Signal | Primary | Three small deltas (upstream-PR candidates): envelope decode-failure logging, mention name cache (`prefillNameCache()` + envelope-fed), inbound images as base64 staged data. The old echo-cache key fix and isMention signal were absorbed upstream in the 2026-08 refork. |
| Telegram | Minimal | One delta: `\~`/`\|` backslash-unescape hunk in `telegram-markdown-sanitize.ts` (upstream adopted the sanitizer file but not this hunk). Otherwise upstream's `/add-telegram` as-is — see personal-use minimization preference. |
| WhatsApp | Not applied | Intentionally absent on this fork. |

### Signal runtime requirement: JRE signal-cli for outbound image attachments

The Signal daemon must run the **JRE distribution** of signal-cli, not the
native binary — GraalVM native builds can't load AWT/ImageIO ("Can't load
library: awt"), so every outbound image attachment send fails while text
keeps working. This install (since 2026-08-15):

- `.env`: `SIGNAL_CLI_PATH=/home/jihartik/.local/share/signal-cli-jre/run-signal-cli.sh`
- Wrapper pins a user-local Temurin JRE (`~/.local/share/temurin-25-jre`)
  because signal-cli 0.14.7 jars need Java 25 while system Java is 21.
- Same data dir as the native binary; `/opt/signal-cli` kept as fallback
  (delete the `SIGNAL_CLI_PATH` line to revert — image sends break again).

When upgrading signal-cli (see the serverGuid-outage runbook in memory),
upgrade the JRE tarball at `~/.local/share/signal-cli-jre/` and check its
required Java version — not just the native binary.

## Container — per-group runtime config

Per-group model override is now **upstream functionality** — the 2026-08
refork dropped the fork's settings-merge extension. `container_configs.model`
(set via `ncl groups config update` or the DB) flows into the group's
`container.json` and the agent-runner passes it to the provider at spawn.
Upstream also no longer clobbers `~/.claude/settings.json` (write-if-missing
plus a memory-settings reconcile), which was the other half of the old fork
patch. The former fork-only fields `thinkingBudget` / `smallModelId` /
`taskModel` had no live usage and were not carried forward.

## Prompt stack: layered persona + memory

The container's effective system prompt is composed at every spawn from
six layers, in this order:

1. **Template persona** (`groups/<folder>/instructions.prepend.md`) —
   upstream's slot, written once by templates at group creation
   (`stageGroupPersona`), emitted as `.claude-fragments/persona.md` and
   imported FIRST. Usually absent in this install (our groups predate
   templates).
2. **Upstream `container/CLAUDE.md`** — imported RO via
   `.claude-shared.md` → `/app/CLAUDE.md`. Generic agent operational
   guidance (workspace, memory rules, communication). We don't patch this
   file (avoids upstream merge conflicts); fork-local content lives in the
   SOUL slots below.
3. **Skill / module / MCP fragments** — under `.claude-fragments/`,
   alphabetically sorted. Built-in (e.g. `module-scheduling.md`) plus any
   MCP-server `instructions` from `container.json`.
4. **Global persona** (`groups/global/SOUL.md`) — emitted as
   `.claude-fragments/soul-global.md` into every non-global group's
   compose. The install-wide identity ("You are Pentti, a trusted family
   assistant…"). Imported after all built-in fragments.
5. **Per-group persona override** (`groups/<folder>/SOUL.md`) — emitted
   as `.claude-fragments/soul-group.md`, imported LAST so the
   group-specific persona wins conflicts. Optional. Use this when a
   particular group needs a role layered on top of the global identity
   ("Pentti as study helper", "Pentti as admin").
6. **Per-group memory** (`groups/<folder>/CLAUDE.local.md`) — auto-loaded
   by the Claude Code SDK using its standard convention (upstream enables
   the `local` settingSource). Two writers: the agent (memory hooks) and
   the human. CLAUDE.local.md is the index — durable always-relevant notes
   go here, larger/growing memory goes in dedicated topic files
   (`MEMORY.md`, `people.md`, `home.md`, `projects.md`) referenced from
   the index.

`groups/<folder>/CLAUDE.md` is **regenerated every spawn** by
`composeGroupClaudeMd` in `src/claude-md-compose.ts` — it is just
`@-imports` plus a header. Don't hand-edit it; changes are clobbered on
next message.

Both SOUL.md files are human-owned. The agent's memory tooling does
not write to them — persona stays stable across sessions even when
memory rotates.

Fork-local source: the two SOUL slots (`soul-global.md` / `soul-group.md`
fragments in `composeGroupClaudeMd`) are the fork's only extension of
upstream's fragment composer. The old `migrateGroupsToClaudeLocal`
preservation patch is gone — upstream deleted that migration and no longer
touches `groups/global/`, which remains the canonical home for
`groups/global/SOUL.md`. SOUL files are deliberately NOT renamed into
upstream's `instructions.prepend.md` slot: that file is template-owned
(written by `stageGroupPersona`) and would collide.

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

- Post-upgrade verification: walk [manual-test-checklist.md](manual-test-checklist.md)
  after every upstream pull or refork switchover.
- 2026-08 refork: replayed base+custom onto upstream main (962 commits ahead)
  via `/refork`. Plan + execution log: `docs/refork-2026-08-15.md`. Notable
  re-shapes: external API moved onto the shared webhook server (`/webhook/api`),
  SOUL layering rebuilt on upstream's fragment composer, settings-merge
  extension dropped (superseded upstream).
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
  out of gws / HA / Wolfram contributions individually. Partly obviated for
  *credentialed* integrations by the OneCLI secret-mode lever (see the Todoist
  section) — that gates the credential, which is the part that matters. The
  `container.json` gate would still be needed to withhold the **mount** and the
  **shim binary**, which is why it remains relevant for gws specifically:
  gws is the one integration where the container holds plaintext credentials,
  so secret-mode cannot gate it.
- ~~Move the Wolfram appid into the vault~~ — **done 2026-08-16**; see the
  Credential management section.
