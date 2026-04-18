# Cloudflare Worker example

Minimal Cloudflare Worker using the agentic router server adapter and D1-backed conversation history.

TypeScript entrypoint: `worker.ts`

TypeScript config: `tsconfig.json`

## Expected bindings

- `HISTORY_DB`: D1 database binding used by `createCloudflareD1HistoryProvider()`

## Routes

- `GET /health`
- `POST /api/flow/run`
- `POST /api/flow/stream`
- `POST /api/flow/reset`

## Example request

```bash
curl -X POST https://<your-worker>/api/flow/run \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "look up the weather in Tokyo",
    "conversationId": "demo-worker"
  }'
```

This example uses the mock provider so it can run without API keys. Replace `createMockLLMProvider()` with a live provider factory and secret-backed API key when needed.
