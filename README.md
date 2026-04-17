# @frame-master/plugin-agentic-ui

Agentic Router plugin for Frame-Master.

## Installation

```bash
bun add @frame-master/plugin-agentic-ui zod
```

## Usage

```typescript
import { AgenticRouter, z } from "@frame-master/plugin-agentic-ui";

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

## Styling The Response

If you want the generated HTML to follow a specific styling strategy, configure it
directly on the router instead of repeating the same instruction in every prompt.

```typescript
import {
  AgenticRouter,
  createGitHubCopilotProvider,
} from "@frame-master/plugin-agentic-ui";

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
} from "@frame-master/plugin-agentic-ui";

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
} from "@frame-master/plugin-agentic-ui";

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
} from "@frame-master/plugin-agentic-ui";

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
import frameMasterPluginAgenticUI from "@frame-master/plugin-agentic-ui";

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
