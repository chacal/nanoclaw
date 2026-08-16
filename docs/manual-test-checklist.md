# Manual test checklist — after an upstream pull / refork

Quick E2E verification of this fork's customizations and integrations.
Run after the service switchover; distilled from the 2026-08-15 refork
(`docs/refork-2026-08-15.md`). Items ordered so failures surface fastest.

## Host sanity (before touching chat)

- [ ] `systemctl --user is-active nanoclaw` — `active`, and stays up (no crash-loop; if "Upgrade tripwire" in error log → `pnpm exec tsx scripts/upgrade-state.ts set` + restart)
- [ ] `ss -ltnp 'sport = :3000'` — exactly one owner, pid belongs to the new process (KillMode orphan check)
- [ ] `logs/nanoclaw.log`: migrations applied (if any), `Signal channel connected`, `Webhook handler registered path="/webhook/api"`
- [ ] `curl http://172.17.0.1:10254/v1/health` — OneCLI gateway `ok` (404 = gateway older than SDK; see `docs/onecli-upgrades.md`)
- [ ] `cat groups/signal_jouni/CLAUDE.md` — last import is `soul-global.md` (kouluapu: `soul-global` then `soul-group` last)

## Basic chat (Signal DM with Pentti)

- [ ] "Hello?" — reply arrives, tone is unmistakably Pentti (SOUL layering)
- [ ] "Do you see our custom tools? HA, wolfram, gws?" — agent confirms the shims and knows how to use them

## Host integrations

- [ ] Ask Pentti to read a sensor from HA (e.g. `sensor.nordpool`) — real value comes back
- [ ] Ask Pentti to check tomorrow's calendar or recent email (gws)
- [ ] Ask Pentti to generate an image with Wolfram **and send it** — image attachment arrives in Signal (outbound attachments need the JRE signal-cli — see the addendum in memory / `SIGNAL_CLI_PATH` in `.env`)

## Images & browser

- [ ] Send Pentti a photo and ask it to describe it — correct description (inbound base64 staging, fork fix)
- [ ] Ask Pentti to grab a screenshot of some website with Chromium and send it — screenshot arrives

## External API (HA webhooks)

- [ ] Local: `curl -X POST http://127.0.0.1:3000/webhook/api -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"event":"upgrade_test"}'` → `{"ok":true}`, log shows `External webhook injected`
- [ ] From HA: trigger a test automation — event arrives AND the reply lands in the Signal DM (`replyTo`). If silent: reload HA REST commands first
- [ ] Bad token → 401 (`curl ... -H 'Authorization: Bearer bogus'`)

## Group behavior (opportunistic, in a Signal group)

- [ ] @-mention a family member — agent sees `@Name`, not `@+358…` (mention name cache)
- [ ] Agent doesn't reply to its own echoed messages; `mention`-mode groups engage only when tagged
- [ ] Scheduled briefs (e.g. morning brief) still arrive on schedule the next day

## Low priority

- [ ] Telegram: ask something whose answer contains `~` or `|` — no stray backslashes
- [ ] `grep 'name cache prefilled' logs/nanoclaw.log` — Signal contact prefill ran at connect
- [ ] Decode-failure logging still present: `grep 'failed to decode' src/channels/signal.ts` (inspection only; guards against silent inbound outages)
