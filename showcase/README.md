# showcase

Bun showcase app for the agentic router.

This demo uses:

- Bun SQLite for the employee database
- Bun SQLite again for persisted conversation history
- `AgenticRouter` with the GitHub Models / Copilot provider
- the browser-side flow client from `ai-prompt-tools-to-ui/client`
- the thin server adapter from `ai-prompt-tools-to-ui/server`
- `Bun.serve()` routes for JSON, SSE, and app asset delivery

## Setup

```bash
bun install
cp .env.exemple .env
```

Set `GITHUB_TOKEN` in `.env` with a token that has `models:read`.

## Interactive Web UI

Start the Bun showcase server:

```bash
bun run dev
```

Open `http://localhost:3001`.

The Web UI demonstrates:

- streamed tool planning and tool results
- streamed HTML output rendered into the main panel
- persistent conversation history backed by Bun SQLite
- correction and confirmation pauses with resume controls
- conversation reset through the server adapter

If `GITHUB_TOKEN` is missing, the showcase falls back to the mock provider and
shows a notice in the UI. Set the token to use live GitHub Models output.

## CLI Mode

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

## Routes

- `GET /` serves the Web UI shell
- `GET /app.js` serves the Bun-built browser bundle
- `GET /api/showcase/overview` serves the current HR snapshot and sample prompts
- `POST /api/flow/run` returns buffered flow responses
- `POST /api/flow/stream` returns streamed SSE flow events
- `POST /api/flow/reset` clears persisted history for a conversation id

## Notes

The original `output.html` artifact is no longer the main showcase surface.
The primary experience is now the Bun-served Web UI, while the CLI path remains
available for quick prompt testing.
