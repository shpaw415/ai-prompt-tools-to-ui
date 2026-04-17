import { describe, expect, it } from "bun:test";
import {
	createChatGPTProvider,
	createClaudeProvider,
	createGeminiProvider,
	createGitHubCopilotProvider,
	type AgenticLLMPlanRequest,
	type AgenticLLMRenderRequest,
	z,
} from "../index";
import { buildPlanPrompt } from "../provider/shared";

describe("vendor providers", () => {
	/**
	 * Covers the planner prompt guidance for interactive corrections.
	 *
	 * This is useful because providers need explicit instructions to avoid
	 * inventing missing arguments when the router can pause for clarification.
	 */
	it("includes missing-argument correction guidance in the planning prompt", () => {
		const prompt = buildPlanPrompt({
			phase: "plan",
			prompt: "create a new admin user",
			outputFormat: "markdown",
			tools: [
				{
					name: "create_user",
					description: "Create a user account.",
					schema: z.object({
						name: z.string().min(2),
						role: z.string().min(2),
					}),
				},
			],
			toolResults: [],
			maxToolCalls: 2,
		} satisfies AgenticLLMPlanRequest);

		expect(prompt).toContain("Do not invent missing required tool arguments.");
		expect(prompt).toContain(
			"select the tool anyway and omit the unknown fields",
		);
	});

	/**
	 * Covers native OpenAI tool calling during the planning phase.
	 *
	 * This is useful because the adapter should now rely on Chat Completions tool
	 * definitions and parse `tool_calls` directly instead of using the earlier
	 * JSON-text planning workaround.
	 */
	it("normalizes OpenAI native tool calls", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> | undefined;

		const provider = createChatGPTProvider({
			apiKey: "openai-key",
			model: "gpt-4.1-mini",
			fetchImplementation: createFetchStub(async (input, init) => {
				capturedUrl = String(input);
				capturedBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;

				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{
											type: "function",
											function: {
												name: "search_catalog",
												arguments: JSON.stringify({ query: "laptop" }),
											},
										},
									],
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});

		const response = await provider.request({
			phase: "plan",
			prompt: "find a laptop",
			outputFormat: "markdown",
			systemInstruction: "Use tools when needed.",
			conversationHistory: [
				{
					role: "user",
					content: "show the current employees",
				},
				{
					role: "assistant",
					content: "Delivered a markdown response without calling any tool.",
				},
			],
			tools: [
				{
					name: "search_catalog",
					description: "Search products.",
					schema: z.object({ query: z.string() }),
				},
			],
			toolResults: [],
			maxToolCalls: 2,
		} satisfies AgenticLLMPlanRequest);

		expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
		expect(capturedBody?.tool_choice).toBe("auto");
		expect(capturedBody?.messages).toMatchObject([
			{
				role: "system",
			},
			{
				role: "user",
				content: expect.anything(),
			},
		]);
		expect(capturedBody?.tools).toMatchObject([
			{
				type: "function",
				function: {
					name: "search_catalog",
					description: "Search products.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string" },
						},
						required: ["query"],
					},
				},
			},
		]);
		expect(response).toEqual({
			phase: "plan",
			toolCalls: [
				{
					toolName: "search_catalog",
					rationale: "Native tool call emitted by OpenAI.",
					arguments: { query: "laptop" },
				},
			],
		});
	});

	/**
	 * Covers Gemini native function calling during the planning phase.
	 *
	 * This is useful because Gemini should rely on its built-in function calling
	 * interface instead of the earlier JSON-text planning workaround.
	 */
	it("normalizes Gemini native function calls", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		const provider = createGeminiProvider({
			apiKey: "gemini-key",
			model: "gemini-2.5-flash",
			fetchImplementation: createFetchStub(async (_input, init) => {
				capturedBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;

				return new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									parts: [
										{
											functionCall: {
												name: "lookup_weather",
												args: { city: "Paris" },
											},
										},
									],
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});

		const response = await provider.request({
			phase: "plan",
			prompt: "what is the weather in paris",
			outputFormat: "markdown",
			tools: [
				{
					name: "lookup_weather",
					description: "Look up the weather by city.",
					schema: z.object({ city: z.string() }),
				},
			],
			toolResults: [],
			maxToolCalls: 1,
		} satisfies AgenticLLMPlanRequest);

		expect(capturedBody?.tools).toMatchObject([
			{
				functionDeclarations: [
					{
						name: "lookup_weather",
						description: "Look up the weather by city.",
						parameters: {
							type: "OBJECT",
							properties: {
								city: { type: "STRING" },
							},
							required: ["city"],
						},
					},
				],
			},
		]);
		expect(response).toEqual({
			phase: "plan",
			toolCalls: [
				{
					toolName: "lookup_weather",
					rationale: "Native tool call emitted by Gemini.",
					arguments: { city: "Paris" },
				},
			],
		});
	});

	/**
	 * Covers OpenAI SSE parsing for streamed render output.
	 *
	 * This is useful because ChatGPT streaming arrives as server-sent events with
	 * delta payloads, and the adapter must convert them into ordered render chunks.
	 */
	it("streams OpenAI render deltas", async () => {
		const provider = createChatGPTProvider({
			apiKey: "openai-key",
			model: "gpt-4.1-mini",
			fetchImplementation: createFetchStub(async () => {
				return new Response(
					createSSEStream([
						'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
						'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
						"data: [DONE]\n\n",
					]),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		});

		const stream = provider.stream;
		if (!stream) {
			throw new Error("OpenAI stream should be defined.");
		}

		const chunks = [];
		for await (const chunk of stream({
			phase: "render",
			prompt: "render hello world",
			outputFormat: "markdown",
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMRenderRequest)) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([
			{ phase: "render", delta: "Hello ", content: "Hello " },
			{ phase: "render", delta: "world", content: "Hello world" },
		]);
	});

	/**
	 * Covers the Gemini adapter request/response translation for the render phase.
	 *
	 * This is useful because render generation still returns structured JSON text
	 * even after the planning phase moved to native function calling.
	 */
	it("normalizes Gemini render responses", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> | undefined;

		const provider = createGeminiProvider({
			apiKey: "gemini-key",
			model: "gemini-2.5-flash",
			fetchImplementation: createFetchStub(async (input, init) => {
				capturedUrl = String(input);
				capturedBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;

				return new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									parts: [{ text: JSON.stringify({ content: "# Gemini UI" }) }],
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});

		const response = await provider.request({
			phase: "render",
			prompt: "render the answer",
			outputFormat: "markdown",
			systemInstruction: "Return markdown.",
			conversationHistory: [
				{
					role: "user",
					content: "show the payroll summary",
				},
			],
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMRenderRequest);

		expect(capturedUrl).toContain(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-key",
		);
		expect(JSON.stringify(capturedBody)).toContain(
			"Recent conversation history:",
		);
		expect(JSON.stringify(capturedBody)).toContain(
			"USER: show the payroll summary",
		);
		expect(response).toEqual({
			phase: "render",
			content: "# Gemini UI",
		});
	});

	/**
	 * Covers Gemini SSE parsing for streamed render output.
	 *
	 * This is useful because Gemini streams through the `streamGenerateContent`
	 * endpoint, and the adapter must preserve the ordered text fragments it receives.
	 */
	it("streams Gemini render deltas", async () => {
		const provider = createGeminiProvider({
			apiKey: "gemini-key",
			model: "gemini-2.5-flash",
			fetchImplementation: createFetchStub(async () => {
				return new Response(
					createSSEStream([
						'data: {"candidates":[{"content":{"parts":[{"text":"# "}]}}]}\n\n',
						'data: {"candidates":[{"content":{"parts":[{"text":"Gemini UI"}]}}]}\n\n',
					]),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		});

		const stream = provider.stream;
		if (!stream) {
			throw new Error("Gemini stream should be defined.");
		}

		const chunks = [];
		for await (const chunk of stream({
			phase: "render",
			prompt: "render gemini ui",
			outputFormat: "markdown",
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMRenderRequest)) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([
			{ phase: "render", delta: "# ", content: "# " },
			{ phase: "render", delta: "Gemini UI", content: "# Gemini UI" },
		]);
	});

	/**
	 * Covers Claude native tool calling during the planning phase.
	 *
	 * This is useful because Anthropic should now emit `tool_use` blocks directly
	 * instead of returning a text blob that the plugin has to parse heuristically.
	 */
	it("normalizes Claude native tool calls", async () => {
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;

		const provider = createClaudeProvider({
			apiKey: "claude-key",
			model: "claude-3-7-sonnet-latest",
			anthropicVersion: "2023-06-01",
			fetchImplementation: createFetchStub(async (_input, init) => {
				capturedHeaders = new Headers(init?.headers);
				capturedBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;

				return new Response(
					JSON.stringify({
						content: [
							{
								type: "tool_use",
								name: "lookup_weather",
								input: { city: "Paris" },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});

		const response = await provider.request({
			phase: "plan",
			prompt: "what is the weather in Paris",
			outputFormat: "html",
			tools: [
				{
					name: "lookup_weather",
					description: "Look up the weather by city.",
					schema: z.object({ city: z.string() }),
				},
			],
			toolResults: [],
			maxToolCalls: 1,
		} satisfies AgenticLLMPlanRequest);

		expect(capturedHeaders?.get("x-api-key")).toBe("claude-key");
		expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01");
		expect(capturedBody?.tools).toMatchObject([
			{
				name: "lookup_weather",
				description: "Look up the weather by city.",
				input_schema: {
					type: "object",
					properties: {
						city: { type: "string" },
					},
					required: ["city"],
				},
			},
		]);
		expect(response).toEqual({
			phase: "plan",
			toolCalls: [
				{
					toolName: "lookup_weather",
					rationale: "Native tool call emitted by Anthropic.",
					arguments: { city: "Paris" },
				},
			],
		});
	});

	/**
	 * Covers Claude SSE parsing for streamed render output.
	 *
	 * This is useful because Anthropic streams typed events rather than raw text
	 * deltas, so the adapter must pick only `content_block_delta` events.
	 */
	it("streams Claude render deltas", async () => {
		const provider = createClaudeProvider({
			apiKey: "claude-key",
			model: "claude-3-7-sonnet-latest",
			fetchImplementation: createFetchStub(async () => {
				return new Response(
					createSSEStream([
						'data: {"type":"message_start"}\n\n',
						'data: {"type":"content_block_delta","delta":{"text":"Hello "}}\n\n',
						'data: {"type":"content_block_delta","delta":{"text":"Claude"}}\n\n',
						'data: {"type":"message_stop"}\n\n',
					]),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		});

		const stream = provider.stream;
		if (!stream) {
			throw new Error("Claude stream should be defined.");
		}

		const chunks = [];
		for await (const chunk of stream({
			phase: "render",
			prompt: "render claude ui",
			outputFormat: "markdown",
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMRenderRequest)) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([
			{ phase: "render", delta: "Hello ", content: "Hello " },
			{ phase: "render", delta: "Claude", content: "Hello Claude" },
		]);
	});

	/**
	 * Covers GitHub Models native tool calling through the GitHub-hosted chat
	 * completions endpoint.
	 *
	 * This is useful because the provider is advertised as a Copilot-facing entry
	 * point, but the actual transport relies on the public GitHub Models API and
	 * must preserve the same tool-calling contract as the other vendors.
	 */
	it("normalizes GitHub Models native tool calls", async () => {
		let capturedUrl = "";
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;

		const provider = createGitHubCopilotProvider({
			apiKey: "github-token",
			model: "openai/gpt-4.1",
			organization: "frame-master",
			fetchImplementation: createFetchStub(async (input, init) => {
				capturedUrl = String(input);
				capturedHeaders = new Headers(init?.headers);
				capturedBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;

				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{
											type: "function",
											function: {
												name: "search_catalog",
												arguments: JSON.stringify({ query: "laptop" }),
											},
										},
									],
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});

		const response = await provider.request({
			phase: "plan",
			prompt: "find a laptop",
			outputFormat: "markdown",
			tools: [
				{
					name: "search_catalog",
					description: "Search products.",
					schema: z.object({ query: z.string() }),
				},
			],
			toolResults: [],
			maxToolCalls: 2,
		} satisfies AgenticLLMPlanRequest);

		expect(capturedUrl).toBe(
			"https://models.github.ai/orgs/frame-master/inference/chat/completions",
		);
		expect(capturedHeaders?.get("authorization")).toBe("Bearer github-token");
		expect(capturedHeaders?.get("accept")).toBe("application/vnd.github+json");
		expect(capturedHeaders?.get("x-github-api-version")).toBe("2026-03-10");
		expect(capturedBody?.model).toBe("openai/gpt-4.1");
		expect(response).toEqual({
			phase: "plan",
			toolCalls: [
				{
					toolName: "search_catalog",
					rationale: "Native tool call emitted by GitHub Models.",
					arguments: { query: "laptop" },
				},
			],
		});
	});

	/**
	 * Covers SSE parsing for GitHub Models streamed render output.
	 *
	 * This is useful because GitHub Models exposes OpenAI-style chat completion
	 * streaming, and the adapter must normalize those deltas into the shared render
	 * chunk contract used by the router.
	 */
	it("streams GitHub Models render deltas", async () => {
		const provider = createGitHubCopilotProvider({
			apiKey: "github-token",
			model: "openai/gpt-4.1",
			fetchImplementation: createFetchStub(async () => {
				return new Response(
					createSSEStream([
						'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
						'data: {"choices":[{"delta":{"content":"GitHub"}}]}\n\n',
						"data: [DONE]\n\n",
					]),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		});

		const stream = provider.stream;
		if (!stream) {
			throw new Error("GitHub Models stream should be defined.");
		}

		const chunks = [];
		for await (const chunk of stream({
			phase: "render",
			prompt: "render github ui",
			outputFormat: "markdown",
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMRenderRequest)) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([
			{ phase: "render", delta: "Hello ", content: "Hello " },
			{ phase: "render", delta: "GitHub", content: "Hello GitHub" },
		]);
	});
});

function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(event));
			}

			controller.close();
		},
	});
}

function createFetchStub(
	handler: (
		input: string | Request | URL,
		init?: RequestInit,
	) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, {
		preconnect: fetch.preconnect.bind(fetch),
	}) as typeof fetch;
}
