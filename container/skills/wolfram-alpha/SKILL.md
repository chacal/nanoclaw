---
name: wolfram-alpha
description: Query Wolfram Alpha for computations, math, science, data lookups, unit conversions, and more. Returns results as PNG images saved to disk. Use for any factual/computational question where Wolfram Alpha would give a better answer than a web search.
allowed-tools: Bash(/app/skills/wolfram-alpha/wolfram-alpha:*)
---

# Wolfram Alpha Query Tool

## Usage

The script is `/app/skills/wolfram-alpha/wolfram-alpha`. It is not on `PATH`: always call it with the full path.

```bash
/app/skills/wolfram-alpha/wolfram-alpha "your query here"                          # Auto-named file in workspace
/app/skills/wolfram-alpha/wolfram-alpha "your query here" /workspace/agent/out.png # Specific output path
```

## Examples

```bash
/app/skills/wolfram-alpha/wolfram-alpha "integrate x^2 from 0 to 5"
/app/skills/wolfram-alpha/wolfram-alpha "population of Helsinki vs Tampere"
/app/skills/wolfram-alpha/wolfram-alpha "convert 25 celsius to fahrenheit"
/app/skills/wolfram-alpha/wolfram-alpha "ISS current position"
/app/skills/wolfram-alpha/wolfram-alpha "nutritional info for 200g salmon"
/app/skills/wolfram-alpha/wolfram-alpha "solve x^2 + 3x - 4 = 0"
/app/skills/wolfram-alpha/wolfram-alpha "weather in Helsinki"
```

## Output

Prints the absolute path to the saved PNG on success. The image contains Wolfram Alpha's full formatted response including plots, tables, and step-by-step solutions.

## Error handling

- Returns non-zero exit code on failure
- HTTP 501 means Wolfram Alpha couldn't parse the query — try rephrasing
- HTTP 400/401 means the credential wasn't injected — either the install has no `Wolfram Alpha` vault secret, or it is not granted to this agent in OneCLI. Nothing to fix inside the container; report it to the operator. Never ask the user for an appid.
