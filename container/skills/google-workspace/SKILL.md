---
name: google-workspace
description: Read and write Google Drive, Docs, Sheets, Gmail, and Calendar with the `gws` CLI. Use for any Google Workspace task — finding files shared with you, reading a Google Doc, creating or sharing documents, checking calendar events, or searching mail. Do not use curl against googleapis.com and do not send OneCLI "connect Google" links.
allowed-tools: Bash(gws:*)
---

# Google Workspace (`gws`)

The `gws` CLI is already authenticated. Its credentials are mounted at
`$GOOGLE_WORKSPACE_CLI_CONFIG_DIR`. You do not need to connect anything.

- Always use `gws` for Google APIs.
- Do not call `https://www.googleapis.com/...` with curl. The OneCLI gateway
  has no Google credentials, so those calls fail.
- Do not send OneCLI `connections?connect=google-...` links to users. The
  Google account is already connected through `gws`.
- If `gws` itself fails, show the error text to the user. Do not guess.

## Usage

```bash
gws <service> <resource> [sub-resource] <method> --params '<JSON>' [--json '<body>']
gws schema <service.resource.method>        # show the parameters of a method
```

Services: `drive`, `docs`, `sheets`, `slides`, `gmail`, `calendar`, `tasks`, `forms`.

## Examples

```bash
# Files that someone shared recently
gws drive files list --params '{"q": "sharedWithMe", "orderBy": "sharedWithMeTime desc", "pageSize": 10, "fields": "files(id,name,mimeType,owners(displayName))"}'

# Search by name
gws drive files list --params '{"q": "name contains '\''historia'\''", "fields": "files(id,name,mimeType)"}'

# Read a Google Doc as plain text
gws drive files export --params '{"fileId": "<id>", "mimeType": "text/plain"}' --output /tmp/doc.txt

# Read a Sheet range
gws sheets spreadsheets values get --params '{"spreadsheetId": "<id>", "range": "A1:D20"}'

# Create a Doc and append text
gws docs documents create --json '{"title": "Harjoituskysymykset"}'
gws docs +write --help

# Share a file
gws drive permissions create --params '{"fileId": "<id>"}' --json '{"type": "user", "role": "writer", "emailAddress": "someone@example.com"}'

# Upload a local file
gws drive +upload --help

# Calendar events (note: `calendar events`, not `events`)
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-01-01T00:00:00Z", "singleEvents": true, "orderBy": "startTime"}'
```

Output is JSON by default. Add `--format table` for a short human view.
