# May 2026 v1 to v2 Migration Summary

This fork was migrated from the v1.2.x line to the v2 architecture in May
2026. The cleaned branch history intentionally keeps only durable
customizations on top of the frozen `base` branch:

- external HTTP API channel for authenticated webhook input
- Signal channel fixes for mentions, image attachments, and echo handling
- per-group Claude settings merge behavior
- install-wide host integrations for Google Workspace, Home Assistant, and
  Wolfram Alpha
- layered global and per-group `SOUL.md` persona composition
- v2 session backup script
- fork documentation and local artifact ignores

Migration-process files are not part of the cleaned stack. The detailed audit
trail, smoke-walk notes, stage reviews, and handoff records remain available on
the archive branch:

`archive/custom-pre-cleanup-2026-05-05`

Use that archive only when investigating the migration process itself. For
future upstream replays, use the cleaned commits on this branch as the source
of durable fork behavior.
