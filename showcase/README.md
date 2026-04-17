# showcase

Bun showcase app for the agentic router.

This demo uses:

- Bun SQLite for the employee database
- Bun SQLite again for persisted conversation history
- `AgenticRouter` with the GitHub Models / Copilot provider
- HTML output written to `output.html`

## Setup

```bash
bun install
cp .env.exemple .env
```

Set `GITHUB_TOKEN` in `.env` with a token that has `models:read`.

## Run

Start a one-off prompt:

```bash
bun run index.ts "show the current employees and summarize the payroll"
```

Run with a stable conversation id so follow-up adjustments keep context:

```bash
bun run index.ts --conversation=hr-demo "show the current employees"
bun run index.ts --conversation=hr-demo "increase Karim Diallo salary by 1000 more"
```

Or use the script shortcut:

```bash
bun run prompt:history "remove Mina Rossi and summarize the payroll impact"
```

## Serve Output

```bash
bun run serve:out
```

This serves `output.html` on port `3001`.
