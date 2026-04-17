# AI-prompt-tools-to-UI

Agentic Router plugin for Frame-Master.

## Installation

```bash
bun add ai-prompt-tools-to-ui
```

## Usage

```typescript
import { AgenticRouter, z } from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  model: "mock-agentic-llm",
  outputFormat: "markdown",
  useStreaming: false,
});

router.registerTool(
  "search_catalog",
  "Search the internal product catalog by free-form query.",
  z.object({
    query: z.string().min(2),
  }),
  async ({ query }) => {
    return {
      items: [
        { id: "sku_1", title: `Match for ${query}` },
        { id: "sku_2", title: `Alternative for ${query}` },
      ],
    };
  },
);

const response = await router.runAndRender(
  "Use search_catalog to find a laptop for travel",
  "Return a concise UI fragment ready for display.",
);

console.log(response.content);
```

## Conversation History

The router can persist prior turns through a pluggable history provider. History
is loaded per call by passing a `conversationId` in the third argument of
`runAndRender()` or `runAndRenderStream()`.

```typescript
import {
  AgenticRouter,
  createBunSQLiteHistoryProvider,
  createCloudflareD1HistoryProvider,
  createCloudflareKVHistoryProvider,
  createInMemoryHistoryProvider,
} from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  outputFormat: "markdown",
  historyProvider: createInMemoryHistoryProvider(),
});

await router.runAndRender(
  "List the current employees",
  "Use tools before guessing.",
  { conversationId: "hr-demo" },
);

await router.runAndRender(
  "Increase Karim salary by 1000 more",
  "Use tools before guessing.",
  { conversationId: "hr-demo" },
);
```

The built-in contract is intentionally small:

- `get(conversationId)` loads prior messages
- `set(conversationId, messages)` persists the updated thread

That means you can back it with in-memory storage, SQLite, Redis, files, or any
other store that fits your app.

Built-in providers now available:

- `createInMemoryHistoryProvider()`
- `createBunSQLiteHistoryProvider({ database })`
- `createCloudflareD1HistoryProvider({ database })`
- `createCloudflareKVHistoryProvider({ namespace })`

Example with Bun SQLite:

```typescript
import { Database } from "bun:sqlite";
import {
  AgenticRouter,
  createBunSQLiteHistoryProvider,
} from "ai-prompt-tools-to-ui";

const database = new Database("./history.sqlite", { create: true });

const router = new AgenticRouter({
  outputFormat: "markdown",
  historyProvider: createBunSQLiteHistoryProvider({ database }),
});
```

## Interactive Corrections

The router can pause before tool execution when a required field is missing or
when a sensitive action needs explicit confirmation. This is useful for real
client/server flows where the server must return a structured question to the
client, wait for the user answer, then continue on a later request.

Enable it with `enableInteractiveCorrections: true`.

```typescript
import { AgenticRouter, z } from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  outputFormat: "markdown",
  enableInteractiveCorrections: true,
});

router.registerTool(
  "create_user",
  "Create a user account.",
  z.object({
    name: z.string().min(2),
    role: z.string().min(2),
  }),
  async ({ name, role }) => ({ created: true, name, role }),
);

const firstResponse = await router.runAndRender("Create a new admin user");

if (firstResponse.status === "needs-user-input") {
  console.log(firstResponse.pendingCorrection);
}
```

When the router pauses, the response contains:

- `status: "needs-user-input"`
- `pendingCorrection.reason`: `validation-required` or `confirmation-required`
- `pendingCorrection.fields`: missing or invalid fields the client should collect
- `pendingCorrection.toolCall`: the pending tool call to resume later
- `content`: a renderable fallback message for immediate UI display

To resume, send the client answer back through `runOptions.correctionAnswer`.

```typescript
const resumedResponse = await router.runAndRender("Alice Martin", undefined, {
  correctionAnswer: {
    pendingCorrection: firstResponse.pendingCorrection!,
    values: {
      name: "Alice Martin",
    },
  },
});
```

The router merges `values` into the pending tool call, validates again, then
continues the normal plan -> execute -> render flow. If the answer is still not
sufficient, it pauses again with a new `pendingCorrection` payload.

### HTML Correction Form

If your router returns HTML, you can ask it to render a real correction form
instead of a plain message block.

```typescript
const router = new AgenticRouter({
  outputFormat: "html",
  enableInteractiveCorrections: true,
  interactiveCorrectionForm: {
    callbackName: "handleAgenticCorrection",
  },
});
```

When a correction is required, the HTML `content` contains a `<form>` with:

- `data-agentic-callback="handleAgenticCorrection"`
- a hidden serialized `pendingCorrection` payload
- a hidden `conversationId` field when one is available
- visible inputs for missing required values
- a confirmation submit button for sensitive actions

The router does not own the actual browser-side JavaScript. The intended client
flow is:

1. Render the returned HTML.
2. Find the form by class or `data-agentic-callback`.
3. Attach your own JavaScript handler for that callback name.
4. Read the visible form values plus the hidden `pendingCorrection` and `conversationId` fields.
5. Send a new server request with `correctionAnswer`.

This keeps the router responsible for HTML structure and resume payloads, while
your application stays responsible for the real transport logic.

### Confirmation For Sensitive Tools

You can mark a tool as requiring an explicit confirmation before it executes.

```typescript
router.registerTool(
  "remove_employee",
  "Remove an employee from the HR database.",
  z.object({
    name: z.string().min(2),
  }),
  async ({ name }) => ({ removed: name }),
  {
    requiresConfirmation: true,
    confirmationKey: "remove-employee",
    confirmationMessage:
      "Please confirm that you want to remove this employee.",
  },
);
```

Resume a confirmation-required action by sending `confirmed: true`.

```typescript
const confirmedResponse = await router.runAndRender("Yes, continue", undefined, {
  correctionAnswer: {
    pendingCorrection: firstResponse.pendingCorrection!,
    confirmed: true,
  },
});
```

### Streaming Behavior

`runAndRenderStream()` also supports this flow. When more user input is needed,
the stream emits `needs-user-input` instead of `done`.

```typescript
for await (const event of router.runAndRenderStream("Create a new admin user")) {
  if (event.type === "needs-user-input") {
    console.log(event.response.pendingCorrection);
  }

  if (event.type === "render") {
    process.stdout.write(event.delta);
  }
}
```

### With Or Without History

This feature works without a history provider. In that case, your client must
send the full `pendingCorrection` payload back to the server on resume.

If a `historyProvider` and `conversationId` are configured, paused turns and
follow-up clarifications are also persisted in conversation history, which makes
multi-request audit and replay simpler.

### Recommended HTTP Shape

Typical server flow:

1. Call `runAndRender(userPrompt, systemInstruction, { conversationId })`.
2. If the response status is `completed`, return the rendered content.
3. If the response status is `needs-user-input`, return `pendingCorrection` to the client.
4. Collect the missing fields or confirmation in the client UI.
5. Call `runAndRender(followUpPrompt, systemInstruction, { conversationId, correctionAnswer })`.

This transport model is safer than keeping an in-process callback open, because
the correction step naturally crosses the client/server boundary.

## Client SDK

The package now ships with a browser-oriented client entrypoint at
`ai-prompt-tools-to-ui/client`.

Use it when you want the frontend to manage conversation ids, streaming state,
and correction resumes while the real router, provider keys, and sensitive
tools stay on your backend.

```typescript
import {
  AgenticFlowClient,
  createFetchAgenticFlowTransport,
} from "ai-prompt-tools-to-ui/client";

const client = new AgenticFlowClient({
  transport: createFetchAgenticFlowTransport({
    baseUrl: "/api/agentic",
  }),
});

const response = await client.run("Show the current employees", {
  systemInstruction: "Use tools before guessing.",
});

if (response.status === "needs-user-input") {
  await client.resumeCorrection({
    values: {
      name: "Alice Martin",
    },
  });
}
```

The client keeps local state for:

- `conversationId`
- accumulated `content`
- planned tool calls during streaming
- executed tool results
- pending correction payloads
- final completed or paused response

You can observe that state through `client.getState()` or `client.subscribe()`.

### Streaming From The Client SDK

```typescript
for await (const event of client.stream("Show the current employees")) {
  if (event.type === "render") {
    console.log(event.content);
  }

  if (event.type === "needs-user-input") {
    console.log(event.response.pendingCorrection);
  }
}
```

The client updates its internal state while the stream is running, so your UI
can render optimistic tool activity and partial content without rebuilding that
state machine itself.

### Default Proxy Contract

`createFetchAgenticFlowTransport()` assumes a backend proxy with these default
POST endpoints relative to `baseUrl`:

- `run`
- `stream`
- `reset` if you configure `resetPath`

The request body mirrors the router inputs:

```json
{
  "prompt": "Show the current employees",
  "systemInstruction": "Use tools before guessing.",
  "conversationId": "hr-demo",
  "correctionAnswer": {
    "pendingCorrection": { "...": "router payload" },
    "values": { "name": "Alice Martin" },
    "confirmed": true
  }
}
```

The buffered `run` endpoint can return either:

- a raw `AgenticRouterResponse`
- or `{ conversationId, response }`

The streaming endpoint should emit server-sent events with JSON `data:` payloads
containing either:

- a raw `AgenticRouterStreamEvent`
- or `{ conversationId, event }`

That keeps the transport thin and lets your backend stay very close to
`runAndRender()` and `runAndRenderStream()`.

## Styling The Response

If you want the generated HTML to follow a specific styling strategy, configure it
directly on the router instead of repeating the same instruction in every prompt.

```typescript
import {
  AgenticRouter,
  createGitHubCopilotProvider,
} from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  outputFormat: "html",
  useStreaming: true,
  renderStyle: "tailwind",
  renderStyleInstruction:
    "Build a clean dashboard card layout with compact spacing and strong section titles.",
  provider: createGitHubCopilotProvider({
    apiKey: process.env.GITHUB_TOKEN!,
    model: "openai/gpt-4.1",
  }),
});
```

Available values:

- `tailwind`: asks the model to use Tailwind utility classes
- `inline-css`: asks the model to use inline `style="..."` attributes
- `plain-css`: asks the model to return semantic HTML plus a plain `<style>` block

You can still combine this with the `systemInstruction` argument of
`runAndRender()` if you need page-specific design constraints.

## Custom LLM Provider

You can inject any SDK by passing a plain provider object. The router stays in
charge of tool registration, validation, orchestration, and UI rendering flow,
while the provider only handles LLM requests.

```typescript
import {
  AgenticRouter,
  type AgenticLLMProvider,
  z,
} from "ai-prompt-tools-to-ui";

const provider: AgenticLLMProvider = {
  name: "openai-compatible",
  model: "gpt-4.1-mini",
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: "https://api.openai.com/v1",
  client: { sdk: "your-custom-client-instance" },
  metadata: { vendor: "OpenAI" },
  request: async (request) => {
    if (request.phase === "plan") {
      return {
        phase: "plan",
        toolCalls: [
          {
            toolName: "search_catalog",
            rationale: "The user is asking for products.",
            arguments: { query: request.prompt },
          },
        ],
      };
    }

    return {
      phase: "render",
      content: `# Result\n\n${JSON.stringify(request.toolResults, null, 2)}`,
    };
  },
};

const router = new AgenticRouter({
  provider,
  outputFormat: "markdown",
  useStreaming: false,
});

router.registerTool(
  "search_catalog",
  "Search products in the internal catalog.",
  z.object({ query: z.string().min(2) }),
  async ({ query }) => ({ items: [{ id: "sku_1", query }] }),
);
```

## Streaming

The router now supports incremental rendering with `runAndRenderStream()`. Tool
planning and tool execution happen first, then the final UI is streamed through
the configured provider when that provider exposes `stream()` and `useStreaming`
is explicitly enabled.

```typescript
import {
  AgenticRouter,
  createChatGPTProvider,
  createGitHubCopilotProvider,
  z,
} from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  useStreaming: true,
  outputFormat: "markdown",
  provider: createChatGPTProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4.1-mini",
  }),
});

router.registerTool(
  "lookup_weather",
  "Look up the weather by city.",
  z.object({ city: z.string().min(2) }),
  async ({ city }) => ({ city, temperature: 21 }),
);

for await (const event of router.runAndRenderStream("Weather in Paris")) {
  if (event.type === "render") {
    process.stdout.write(event.delta);
  }

  if (event.type === "done") {
    console.log("\nFinal content length:", event.response.content.length);
  }
}
```

## GitHub Copilot / GitHub Models Provider

Oui, mais proprement il faut passer par l'API publique GitHub Models, pas par un
endpoint interne de Copilot Chat. Le provider ajouté dans ce package accepte un
token GitHub avec la permission `models:read` et n'importe quel identifiant de
modèle exposé par GitHub, par exemple `openai/gpt-4.1`,
`anthropic/claude-sonnet-4`, ou d'autres modèles du catalogue.

```typescript
import {
  AgenticRouter,
  createGitHubCopilotProvider,
  z,
} from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  useStreaming: true,
  outputFormat: "markdown",
  provider: createGitHubCopilotProvider({
    apiKey: process.env.GITHUB_TOKEN!,
    model: "openai/gpt-4.1",
  }),
});

router.registerTool(
  "lookup_weather",
  "Look up the weather by city.",
  z.object({ city: z.string().min(2) }),
  async ({ city }) => ({ city, temperature: 21 }),
);
```

## What It Provides

- A strongly typed `AgenticRouter` with native Bun TypeScript support.
- A modular `AgenticLLMProvider` contract so any SDK can be plugged in.
- Opt-in streaming support through `useStreaming`, `runAndRenderStream()`, and provider `stream()` adapters.
- Zod-backed tool registration and runtime validation.
- A mock LLM planner and renderer for prototyping tool calling flows without API keys.
- Native tool calling for OpenAI, Gemini, and Claude planning providers.
- Native tool calling for GitHub Models, including models routed from OpenAI, Anthropic, and other vendors exposed by GitHub.
- Render-ready HTML or Markdown output.

## Frame-Master Plugin Entry

```typescript
import type { FrameMasterConfig } from "frame-master/server/types";
import frameMasterPluginAgenticUI from "ai-prompt-tools-to-ui";

const config: FrameMasterConfig = {
  HTTPServer: { port: 3000 },
  plugins: [
    frameMasterPluginAgenticUI({
      routerOptions: {
        model: "mock-agentic-llm",
        outputFormat: "html",
      },
    }),
  ],
};

export default config;
```

## Notes

If you do not pass a provider, the router automatically uses the exported `createMockLLMProvider()` helper. For production usage, replace it with a real provider object wired to OpenAI, Google, Anthropic, Mistral, or any compatible SDK. Keep `useStreaming: true` only when you explicitly want incremental output.
