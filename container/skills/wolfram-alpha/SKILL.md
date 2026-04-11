---
name: wolfram-alpha
description: Query Wolfram Alpha for computations, math, science, data lookups, unit conversions, and more. Returns results as PNG images saved to disk. Use for any factual/computational question where Wolfram Alpha would give a better answer than a web search.
allowed-tools: Bash(wolfram-alpha:*)
---

# Wolfram Alpha Query Tool

## Usage

```bash
wolfram-alpha "your query here"                          # Auto-named file in workspace
wolfram-alpha "your query here" /workspace/group/out.png # Specific output path
```

## Examples

```bash
wolfram-alpha "integrate x^2 from 0 to 5"
wolfram-alpha "population of Helsinki vs Tampere"
wolfram-alpha "convert 25 celsius to fahrenheit"
wolfram-alpha "ISS current position"
wolfram-alpha "nutritional info for 200g salmon"
wolfram-alpha "solve x^2 + 3x - 4 = 0"
wolfram-alpha "weather in Helsinki"
```

## Output

Prints the absolute path to the saved PNG image on success. The image contains Wolfram Alpha's full formatted response including plots, tables, and step-by-step solutions.

## Error handling

- Returns non-zero exit code on failure
- HTTP 501 means Wolfram Alpha couldn't parse the query — try rephrasing
- If WOLFRAM_API_URL is not configured, the tool will report that
