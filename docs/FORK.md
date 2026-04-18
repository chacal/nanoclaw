# Fork Notes

This repository is a long-lived fork of [`qwibitai/nanoclaw`](https://github.com/qwibitai/nanoclaw) customized for personal use. The upstream README and `docs/` describe the generic NanoClaw engine; this document describes what this fork adds on top and how it is organized so future contributors (human or AI) can work with it without guessing.

## Branch model (hybrid main / base / custom)

The fork uses a three-branch structure adopted during the v1.2.53 migration:

| Branch | Contents | Update rule |
|--------|----------|-------------|
| `main` | Exact mirror of `upstream/main`. | Never diverges. Fast-forward only from `upstream/main`. |
| `base` | `main` + official skill branches and channel forks merged as `--no-ff` merge commits. | Additions land as merges. Mirrors upstream's intended workflow. |
| `custom` | `base` + this fork's own features as **linear** commits. | No merges here, ever (exception: planned `base`-into-`custom` sync during upstream pulls). |

**Why the split:** a purely linear `custom` with merges baked in makes rebase-through-merge brittle (autosquash breaks, amend-into-earlier-commit stops working). A purely merge-native branch loses the "one feature per commit, revertable as a unit" property. Hybrid keeps upstream integrations as revertable merge units while keeping our own features rebase-friendly for future upstream pulls.

**Discipline rule:** before any `git merge` into `custom`, stop. If the work is a skill branch or channel fork, the target is `base`. If it's our own feature, it's a linear commit on `custom`.

**Upstream-pull workflow:**

```bash
git fetch upstream
git checkout main   && git merge --ff-only upstream/main
git checkout base   && git merge main        # resolve conflicts in the skill merges
git checkout custom && git rebase base       # predictable because custom has no merges
```

## Native credential proxy

This fork does **not** use OneCLI Agent Vault (the upstream default). Credentials live in `.env` on the host and are injected into container HTTP requests by a native credential proxy (`src/credential-proxy.ts`) that listens on `:3001`.

Containers see only a proxy URL (`ANTHROPIC_BASE_URL=http://<proxy-host>:3001`). Real API keys and OAuth tokens never enter the container's environment, filesystem, or `/proc`.

### Path-based service routing

The proxy multiplexes multiple upstream services over a single port using path prefixes. Each registered service gets a `/<prefix>/*` namespace; requests matching the prefix are rewritten and forwarded to the configured upstream with the appropriate credential injected.

Current routes (see `src/credential-proxy.ts` for the authoritative list):

| Prefix | Upstream | Credential | Enabled when |
|--------|----------|------------|--------------|
| `/v1/*`, `/api/oauth/claude_cli/*`, `/api/auth/*` | Anthropic API | API key or OAuth token (auto-refresh via `CLAUDE_CREDENTIALS_FILE`) | always |
| `/ha/*` | Home Assistant (`HA_URL`) | Bearer `HA_TOKEN` | `HA_URL` + `HA_TOKEN` set |
| `/wolfram/v1/result`, `/wolfram/v1/simple` | Wolfram Alpha (`WOLFRAM_URL`, defaults to `api.wolframalpha.com`) | `appid` query param from `WOLFRAM_APP_ID` | `WOLFRAM_APP_ID` set |

### Security hardening applied to the proxy

- Segment-boundary path allowlist (prevents `/v1/messagesabc` matches).
- Percent-decode guard against encoded path-traversal (`%2e%2e`).
- RFC 7230 hop-by-hop header scrub on both request and response.
- OAuth credentials file auto-refresh with retry/backoff and atomic `0o600` writes.
- Log-scrubbing when tokens appear in error messages.

Adding a new service route: register it in `src/credential-proxy.ts` next to the HA and Wolfram blocks. Keep path prefixes narrow — prefer `/wolfram/v1/result` over `/wolfram/*`.

## External HTTP API

An external HTTP API listens on `:3002` for message injection from iOS Shortcuts, Home Assistant automations, voice transcription clients, and other webhook sources.

**Endpoints:**
- `POST /voice` — audio upload, transcribed then injected as a message
- `POST /message` — text injection
- `POST /webhook` — generic webhook, forwarded as a message to the target group

**Bearer token identities:** tokens are NOT read from `.env`. They live in `~/.config/nanoclaw/api-tokens.json` (file mode `0600`, outside the project root, never mounted into any container). Each token entry binds a token string to a sender identity:

```json
{
  "tokens": [
    { "token": "<secret>", "sender": "api:owner",   "senderName": "Owner",      "isFromMe": true  },
    { "token": "<secret>", "sender": "api:webhook", "senderName": "HA Webhook", "isFromMe": false }
  ]
}
```

`isFromMe: true` carries owner/admin trust (passes session-command and remote-control gates). `isFromMe: false` still lands the message but goes through the normal sender-allowlist + trigger flow.

Validation is strict: malformed JSON or missing required fields aborts startup (no silent fallback). Implementation: `src/api-tokens.ts#loadApiTokens`.

Any `VOICE_API_TOKEN` / `WEBHOOK_TOKEN` entries still present in `.env` are legacy — the running code does not read them. Useful only as a source-of-truth for what token strings to copy into `api-tokens.json`.

## Custom integrations

### Channels

- **Signal** — primary channel. Text, voice transcription, and image vision.
- **Telegram** — text, voice, images. Main DM configured as a trusted sender.

The WhatsApp skill (available upstream) is intentionally not applied on this fork.

### Container tools

Added to the agent container image on top of the upstream base:

| Tool | Install location | Enabled via |
|------|------------------|-------------|
| `ha-api` | `/usr/local/bin/ha-api` | Injected when HA is configured on the host |
| `wolfram-alpha` | `/usr/local/bin/wolfram-alpha` | Uses `/wolfram/*` proxy route |
| `gws` (Google Workspace CLI v0.22.1+) | `/usr/local/bin/gws` | Host mount `~/.config/gws` → `/workspace/gws-config` (RW). Requires both `credentials.enc` and `.encryption_key` on the host. |
| `ollama` MCP (optional) | MCP server registration | See `/add-ollama-tool` |

### Per-group runtime config

Default model is `claude-sonnet-4-6` via `CLAUDE_CODE_MODEL` in `.env`, with `thinkingBudget: high` and `enableAllProjectMcpServers: true` applied globally by regenerating `data/sessions/*/.claude/settings.json` on every container start (see the Stage 14 runtime-tuning commit).

Individual groups can override this via `containerConfig` on the group record: model, `smallModelId`, thinking budget, and MCP servers. Per-group MCP integrations (e.g. Todoist) go in `groups/<group>/.mcp.overrides.json`.

### Multi-group pattern

The installation is shared across several trusted human users, each with their own registered chat. Every registered group has:

- Its own folder under `groups/<name>/` with `CLAUDE.md` (and optional `SOUL.md`).
- Its own Claude session history at `data/sessions/<name>/.claude/`.
- Independent trigger configuration (some DMs run trigger-less, group chats require the trigger word).
- Independent model / MCP / mount configuration.

Adding a new user: register their chat via the main channel with an appropriate trigger mode, copy any per-user MCP overrides into `.mcp.overrides.json`, and restart the service.

### SOUL.md

Each group folder can have a `SOUL.md` alongside `CLAUDE.md`. Both are loaded into the agent system prompt (`CLAUDE.md` for operational memory, `SOUL.md` for persona/voice that shouldn't be overwritten by routine memory updates).

## Backup

`backup.sh` at the project root backs up everything that isn't in git and isn't regenerated — project-local state plus a curated set of host-side paths that hold identity, credential, and memory files outside the project directory. Uses rsync with `--link-dest` hardlink deduplication against the previous backup and retains a small rolling window.

Run manually or via a systemd timer / cron job:

```bash
./backup.sh
```

Backups land under `~/nanoclaw-backups/<timestamp>/`. The full list of external paths and retention count live at the top of the script — update them when a new integration adds host-side state that isn't in git. Treat the backup archives themselves as sensitive.

## Current migration state

- Fork is on `custom` branch, v1.2.53 hybrid model.
- Migration tag: `custom-v1.2.53-migrated` (the commit the cutover shipped from).
- Pre-migration safety tags retained: `backup/pre-hybrid-surgery`, `backup/pre-replay-main`.
- Pre-migration branch mirror retained at `backup/old-main` (local + origin).

## Service management (Linux)

This fork runs as a systemd user service:

```bash
systemctl --user start   nanoclaw
systemctl --user stop    nanoclaw
systemctl --user restart nanoclaw
systemctl --user status  nanoclaw
journalctl --user -u nanoclaw -f
```

Idle container timeout is set to 4 hours (`IDLE_TIMEOUT=14400000`).
