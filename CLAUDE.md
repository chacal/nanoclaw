# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process. Signal and Telegram channels are built into core; additional channels (WhatsApp, Slack, Discord, Gmail) can be added via skills. Channels self-register at startup — the orchestrator connects whichever ones have credentials present. Messages route to Claude Agent SDK running in Docker containers (Linux VMs). Each group has isolated filesystem and memory. Credential proxy ensures API tokens never enter containers.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/signal.ts` | Signal channel implementation |
| `src/channels/telegram.ts` | Telegram channel implementation |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Container runtime management (Docker/Apple Container) |
| `src/credential-proxy.ts` | HTTP proxy that injects API credentials into container requests |
| `src/group-queue.ts` | Per-group message queue with global concurrency limit |
| `src/mount-security.ts` | Mount allowlist validation for containers |
| `src/sender-allowlist.ts` | Per-group sender filtering |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/voice-api.ts` | Voice transcription HTTP endpoint |
| `src/transcription.ts` | OpenAI audio transcription (gpt-4o-transcribe / whisper-1) |
| `src/session-commands.ts` | Session management commands (/compact, /clear) |
| `src/remote-control.ts` | Remote agent control |
| `groups/{name}/CLAUDE.md` | Per-group agent memory (isolated) |
| `groups/global/CLAUDE.md` | Global agent memory (read by all groups) |
| `container/agent-runner/` | Code that runs inside the container (agent loop, IPC) |
| `container/skills/` | Skills available to all agents (browser, capabilities, status) |

## Features

- **Multi-channel**: Signal and Telegram built-in; WhatsApp, Slack, Discord, Gmail via skills
- **Container isolation**: Agents run in Docker containers with filesystem isolation
- **Credential proxy**: API tokens never enter containers; injected via HTTP proxy
- **Image vision**: Agents can see images sent via Telegram and Signal
- **Voice transcription**: Voice messages transcribed via OpenAI (gpt-4o-transcribe, whisper-1 fallback)
- **Agent swarms**: Teams of specialized agents that collaborate (Telegram)
- **Scheduled tasks**: Recurring/one-time jobs that run as full agents
- **Web access**: Search and fetch content; browser automation via agent-browser

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Architecture Notes

- **Credential proxy** (`src/credential-proxy.ts`): Real secrets never enter containers. The host runs an HTTP proxy with path-based routing that injects credentials for multiple services. Default path → Anthropic API (API key or OAuth token). `/ha/` → Home Assistant (bearer token). `/wolfram/` → Wolfram Alpha (appid query param). Containers only see proxy URLs (`ANTHROPIC_BASE_URL`, `HA_API_URL`, `WOLFRAM_API_URL`) — no real keys.
- **IPC**: File-based (`data/ipc/`). Containers write JSON files; host polls and processes them. Used for send_message, task scheduling, group registration.
- **Mount security** (`src/mount-security.ts`): External allowlist at `~/.config/nanoclaw/mount-allowlist.json` controls what host paths can be mounted. Blocked patterns prevent mounting `.ssh`, `.env`, credentials, etc.
- **Group queue** (`src/group-queue.ts`): Serializes agent invocations per group with a global concurrency limit. Supports both fresh container spawns and piping into running containers.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
