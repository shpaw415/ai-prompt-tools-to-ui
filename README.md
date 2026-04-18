# AI-prompt-tools

Tool-first agentic router for Frame-Master and Bun apps.

The package plans tool calls with a pluggable LLM provider, executes your registered tools, then returns a grounded plain-text summary plus the raw tool results.

## Installation

```bash
bun add ai-prompt-tools-to-ui
```

## Basic usage

```typescript
import { AgenticRouter, z } from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  model: "mock-agentic-llm",
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

const response = await router.runAndRespond(
  "Use search_catalog to find a laptop for travel",
  "Use tools before guessing and summarize only verified results.",
);

console.log(response.content);
console.log(response.toolCalls);
```

`response.content` is the final grounded summary.

`response.toolCalls` is the raw execution record for each tool call, including arguments, results, rationale, and duration.

## Response resolver

If you already know how to summarize certain tool results, you can bypass the provider response phase with `responseResolver`.

```typescript
import {
  AgenticRouter,
  type AgenticLLMResponseRequest,
} from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  responseResolver: async (request: AgenticLLMResponseRequest) => {
    const lastResult = request.toolResults.at(-1);

    if (lastResult?.toolName !== "list_employees") {
      return undefined;
    }

    return {
      phase: "respond",
      content: `Employee snapshot: ${JSON.stringify(lastResult.result)}`,
    };
  },
});
```

The resolver runs before the provider response call in both `runAndRespond()` and `runAndRespondStream()`.

## Conversation history

The router can persist prior turns through a pluggable history provider. History is loaded per call by passing a `conversationId` in the third argument of `runAndRespond()` or `runAndRespondStream()`.

```typescript
import {
  AgenticRouter,
  createInMemoryHistoryProvider,
} from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
  historyProvider: createInMemoryHistoryProvider(),
});

await router.runAndRespond(
  "List the current employees",
  "Use tools before guessing.",
  { conversationId: "hr-demo" },
);

await router.runAndRespond(
  "Increase Karim salary by 1000 more",
  "Use tools before guessing.",
  { conversationId: "hr-demo" },
);
```

Built-in providers:

- `createInMemoryHistoryProvider()`
- `createBunSQLiteHistoryProvider({ database })`
- `createCloudflareD1HistoryProvider({ database })`
- `createCloudflareKVHistoryProvider({ namespace })`

## Interactive corrections

The router can pause before tool execution when a required field is missing or when a sensitive action needs explicit confirmation.

```typescript
import { AgenticRouter, z } from "ai-prompt-tools-to-ui";

const router = new AgenticRouter({
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

const firstResponse = await router.runAndRespond("Create a new admin user");

if (firstResponse.status === "needs-user-input" && firstResponse.pendingCorrection) {
  const resumedResponse = await router.runAndRespond("Alice Martin", undefined, {
    correctionAnswer: {
      pendingCorrection: firstResponse.pendingCorrection,
      values: {
        name: "Alice Martin",
      },
    },
  });

  console.log(resumedResponse.content);
}
```

Paused responses include structured `pendingCorrection` metadata plus a plain-text `content` message you can show immediately.

## Streaming

Streaming emits tool activity first and response chunks last.

```typescript
for await (const event of router.runAndRespondStream("Weather in Paris")) {
  if (event.type === "tool-call") {
    console.log("planning", event.toolCall);
  }

  if (event.type === "tool-result") {
    console.log("result", event.result);
  }

  if (event.type === "response") {
    console.log("partial summary", event.content);
  }

  if (event.type === "done") {
    console.log("final response", event.response);
  }
}
```

## Client and server adapters

The package ships with:

- `ai-prompt-tools-to-ui/client` for browser-side flow state and fetch transport helpers
- `ai-prompt-tools-to-ui/server` for thin server adapters and SSE helpers

These adapters preserve the same summary-plus-tool-results contract used by the core router.

## Providers

Built-in provider factories:

- `createOpenAIProvider()` / `createChatGPTProvider()`
- `createGoogleProvider()` / `createGeminiProvider()`
- `createAnthropicProvider()` / `createClaudeProvider()`
- `createGitHubModelsProvider()` / `createGitHubCopilotProvider()`
- `createMockLLMProvider()`

The router remains provider-agnostic. Providers only need to support the planning request plus the final response synthesis request.

## Features

- Tool registration with Zod-backed validation.
- Provider-agnostic planning and final summary generation.
- Streaming support for tool activity and response chunks.
- Pause/resume corrections for missing fields and confirmations.
- Pluggable conversation history providers.
- Browser/client and server adapter helpers.

## Examples

- Minimal Node HTTP server: [exemples/node/README.md](exemples/node/README.md)
- Minimal Cloudflare Worker: [exemples/cloudflare/README.md](exemples/cloudflare/README.md)
