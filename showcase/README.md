# showcase

Bun showcase app for the tool-first agentic router.

This demo uses:

- Bun SQLite for the employee database
- Bun SQLite again for persisted conversation history
- `AgenticRouter` with the GitHub Models / Copilot provider or the mock provider fallback
- the browser-side flow client from `ai-prompt-tools-to-ui/client`
- the thin server adapter from `ai-prompt-tools-to-ui/server`
- `Bun.serve()` routes for JSON, SSE, and app asset delivery

## Setup

```bash
bun install
cp .env.exemple .env
```

Set `PROVIDER_TYPE` in `.env` to choose the LLM provider:

- `github` (uses `GITHUB_TOKEN`)
- `google` (uses `GOOGLE_API_KEY`)
- `anthropic` (uses `ANTHROPIC_API_KEY`)
- `openai` (uses `OPENAI_API_KEY`)

If the selected provider API key is missing, the showcase falls back to the built-in mock provider.

Set `MODEL` optionally to override the provider model id.

## Interactive web UI

Start the Bun showcase server:

```bash
bun run dev
```

Open `http://localhost:3001`.

The Web UI demonstrates:

- streamed tool planning and tool results
- streamed grounded text summaries in the main panel
- persistent conversation history backed by Bun SQLite
- correction and confirmation pauses with resume controls
- conversation reset through the server adapter

## CLI mode

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

The showcase no longer writes or renders a generated HTML dashboard. The primary experience is the Bun-served Web UI and CLI returning plain-text summaries backed by raw tool results.
