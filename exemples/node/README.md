# Node example

Minimal Node 20+ HTTP server using the agentic router server adapter.

TypeScript entrypoint: `server.ts`

TypeScript config: `tsconfig.json`

## Run

```bash
node --experimental-strip-types ./exemples/node/server.ts
```

## Endpoints

- `GET /health`
- `POST /api/flow/run`
- `POST /api/flow/stream`
- `POST /api/flow/reset`

## Example request

```bash
curl -X POST http://localhost:3000/api/flow/run \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "look up the weather in Paris",
    "conversationId": "demo-node"
  }'
```

This example uses the mock provider so it can run without API keys. Replace `createMockLLMProvider()` with any built-in provider factory when you want live model output.
