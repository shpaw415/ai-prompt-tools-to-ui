# React client example

Minimal client-side React example using the package client SDK.

## What it shows

- `createFetchAgenticFlowTransport()` pointing at `/api/flow`
- `AgenticFlowClient` state subscription in React
- streamed prompt execution with `client.stream()`
- correction resume with `client.resumeCorrectionStream()`
- remote history reset with `client.reset()`

## Files

- `src/App.tsx` — the React client implementation
- `src/main.tsx` — React entrypoint
- `index.html` — Vite HTML shell
- `tsconfig.json` — TypeScript config
- `vite.config.ts` — dev proxy for `/api/flow`

## Run

Install dependencies:

```bash
cd exemples/react
npm install
```

Start a backend first. The simplest option is the Node example from [../node/README.md](/home/shpaw415/frame-master-plugins/frame-master-plugin-AI-route-to-UI/exemples/node/README.md), which serves `/api/flow/*` on `http://localhost:3000`.

Then start the React app:

```bash
npm run dev
```

Vite serves the app on `http://localhost:5173` and proxies `/api/flow/*` to `http://localhost:3000`.

## Notes

This example is intentionally client-side only. It relies on a separate backend exposing the flow endpoints, such as the Node or Cloudflare examples in this repository.
