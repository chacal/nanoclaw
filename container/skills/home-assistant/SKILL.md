---
name: home-assistant
description: Read and control the household Home Assistant (sensors, lights, heating, electricity prices, automations) through its REST API with the `ha-api` script. Use for any question about the home's current state or any request to change something at home.
allowed-tools: Bash(/app/skills/home-assistant/ha-api:*)
---

# Home Assistant

The script is `/app/skills/home-assistant/ha-api`. It is not on `PATH`: always
call it with the full path. (Older notes may say `ha-api` or
`/usr/local/bin/ha-api`; both are gone.)

```bash
HA=/app/skills/home-assistant/ha-api
$HA GET /api/states/sensor.nordpool                 # one entity
$HA GET /api/states                                 # all entities (large)
$HA GET "/api/history/period/2026-03-22T00:00:00Z?filter_entity_id=sensor.vallox_outdoor_air"
$HA POST /api/services/light/turn_on '{"entity_id":"light.kitchen"}'
```

Output is the raw JSON from Home Assistant. The image has no `jq`: pick fields with
`node -e` or `bun -e`.

## Credentials

You never handle the Home Assistant token. The OneCLI gateway adds it to
requests for the Home Assistant host. If a call fails with 401, the gateway did
not add the token for this agent: tell the user that the operator must check
it. Never ask anyone for a token.

## Rules

- Read freely. Before you change something (lights, heating, locks,
  automations), make sure the user asked for that change.
- `GET /api/states` returns hundreds of entities; filter it (`node -e`) instead
  of reading all of it.
