# Manual test checklist — after an upstream pull / refork

Quick E2E check of this fork's customizations and integrations. Run after the
service switchover. Items are ordered so failures show up fastest.
History: 2026-08-15 refork, rewritten for the 2026-11-21 refork (2026.11.0).

## Host sanity (before chat)

- [ ] `systemctl --user is-active nanoclaw` — `active`, stays up. If the error
      log says "Upgrade tripwire": `pnpm exec tsx scripts/upgrade-state.ts set` + restart
- [ ] `ss -ltnp 'sport = :3000'` — at most one owner, the new PID (KillMode
      orphan check). `WEBHOOK_HOST` unset → it listens on 127.0.0.1 only
- [ ] `logs/nanoclaw.log`: migrations applied, `Signal channel connected`,
      Telegram adapter started, no `Refusing` / `admission` errors
- [ ] `curl -s http://172.17.0.1:10254/api/health` — `version` is the pin in
      `.claude/skills/add-onecli/versions.json`
- [ ] From docker0, :10254 is refused and :10255 answers (ops guard intact):
      `docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl -s -o /dev/null -w '%{http_code}\n' -m5 http://host.docker.internal:10254/v1/health` → `000`
- [ ] `head -5 groups/signal_kouluapu/CLAUDE.md` — first section is `# Persona`
      with the Pentti text; Kouluapu's study-helper role follows

## Chat (Jouni's DM with Pentti — Signal, and Telegram for the shared-session check)

- [ ] "Hello?" — reply arrives, tone is Pentti (persona via `instructions.prepend.md`)
- [ ] Ask for a sensor value (e.g. `sensor.nordpool`) — real value (home-assistant skill)
- [ ] Ask Wolfram for an image **and send it** — image arrives in Signal
      (outbound attachments need the JRE signal-cli, `SIGNAL_CLI_PATH`)
- [ ] Ask for tomorrow's calendar / a recent email — works through the OneCLI
      Google connection (only in groups that were granted it)
- [ ] Todoist: Pentti lists tasks (only Pentti has the Todoist MCP server and grant)
- [ ] Shared session: say something on Signal, ask about it on Telegram — same
      conversation; the reply comes back in Telegram
- [ ] Google: family calendar (Pentti's account); Jouni's own mail (read-only);
      a write to Jouni's account is refused; a Gmail send from a kids' group gives
      an approval card in Telegram

## Images & browser

- [ ] Send a photo, ask for a description — correct (fork fix: base64 staging)
- [ ] Ask for a screenshot of a website and send it — screenshot arrives

## Scheduled work

- [ ] Morning brief: unplug the phone after 05:30 (or set
      `input_datetime.jouni_woke_up` to now in HA) — brief arrives within 5 min,
      only once. The 09:15 fallback then skips
- [ ] 15:00 heating report arrives (reads haukkakallio `summary.json`)

## Group behavior (opportunistic, in a Signal group)

- [ ] @-mention a family member — agent sees `@Name`, not `@+358…` (name cache)
- [ ] In Kouluapu, the agent tells the twins apart (sender names, `sender_id`)
- [ ] `mention`-mode groups engage only when tagged

## Low priority

- [ ] Telegram: one message with `~` and `|` — no stray backslashes
- [ ] `grep 'name cache prefilled' logs/nanoclaw.log` — contact prefill ran
- [ ] `grep -c 'failed to decode' src/channels/signal.ts` ≥ 1 (decode logging
      still in the adapter after an update; `/update-nanoclaw` re-copies channels)
