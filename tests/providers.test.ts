import { describe, expect, it } from "bun:test";
import {
	createChatGPTProvider,
	createClaudeProvider,
	createGeminiProvider,
	createGitHubCopilotProvider,
	type AgenticLLMPlanRequest,
	type AgenticLLMResponseRequest,
	z,
} from "../index";
import {
	buildNativePlanPrompt,
	buildPlanPrompt,
	buildResponsePrompt,
} from "../provider/shared";

describe("provider prompts and adapters", () => {
	it("includes missing-argument guidance in planning prompts", () => {
		const prompt = buildPlanPrompt({
			phase: "plan",
			prompt: "create a new admin user",
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
			"For mutation tools (create/add/update/remove/delete/adjust), never guess required values.",
		);
		expect(prompt).toContain(
			"select the tool anyway and omit the unknown fields",
		);
	});

	it("forbids hand-written forms in native planning prompts", () => {
		const prompt = buildNativePlanPrompt({
			phase: "plan",
			prompt: "create a new employee",
			systemInstruction:
				"For employee mutations, use tools and rely on correction flow for missing fields.",
			tools: [
				{
					name: "add_employee",
					description: "Add a new employee.",
					schema: z.object({
						name: z.string().min(2),
						role: z.string().min(2),
						department: z.string().min(2),
						salary: z.number().positive(),
					}),
				},
			],
			toolResults: [],
			maxToolCalls: 2,
		} satisfies AgenticLLMPlanRequest);

		expect(prompt).toContain("Planning is not the render phase.");
		expect(prompt).toContain(
			"For mutation tools (create/add/update/remove/delete/adjust), never guess required values.",
		);
		expect(prompt).toContain("do not replace a missing-argument tool call");
	});

	it("builds response prompts around grounded summaries", () => {
		const prompt = buildResponsePrompt({
			phase: "respond",
			prompt: "Show payroll",
			tools: [],
			toolResults: [
				{
					toolName: "list_employees",
					rationale: "Need the current roster.",
					arguments: {},
					result: { count: 3 },
					durationMs: 8,
				},
			],
		} satisfies AgenticLLMResponseRequest);

		expect(prompt).toContain("Summarize only what the tool results prove.");
		expect(prompt).toContain("Executed tool results");
	});

	it("normalizes OpenAI native tool calls", async () => {
		const provider = createChatGPTProvider({
			apiKey: "openai-key",
			model: "gpt-4.1-mini",
			fetchImplementation: createFetchStub(async () => {
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
			systemInstruction: "Use tools when needed.",
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

	it("parses Gemini response payloads as final summaries", async () => {
		const provider = createGeminiProvider({
			apiKey: "gemini-key",
			model: "gemini-2.5-flash",
			fetchImplementation: createFetchStub(async () => {
				return new Response(
					JSON.stringify({
						candidates: [
							{
								content: { parts: [{ text: '{"content":"Gemini summary"}' }] },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});

		const response = await provider.request({
			phase: "respond",
			prompt: "Show payroll",
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMResponseRequest);

		expect(response).toEqual({ phase: "respond", content: "Gemini summary" });
	});

	it("streams Anthropic response chunks", async () => {
		const provider = createClaudeProvider({
			apiKey: "anthropic-key",
			model: "claude-sonnet-4",
			fetchImplementation: createFetchStub(async () => {
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"content_block_delta","delta":{"text":"Hello "}}\n\n' +
									'data: {"type":"content_block_delta","delta":{"text":"Claude"}}\n\n' +
									"data: [DONE]\n\n",
							),
						);
						controller.close();
					},
				});
				return new Response(stream, { status: 200 });
			}),
		});

		const chunks = [];
		const stream = provider.stream;
		if (!stream) {
			throw new Error("Expected Anthropic provider stream support.");
		}
		for await (const chunk of stream({
			phase: "respond",
			prompt: "hello",
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMResponseRequest)) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([
			{ phase: "respond", delta: "Hello ", content: "Hello " },
			{ phase: "respond", delta: "Claude", content: "Hello Claude" },
		]);
	});

	it("streams GitHub response chunks", async () => {
		const provider = createGitHubCopilotProvider({
			apiKey: "github-key",
			model: "openai/gpt-4.1",
			fetchImplementation: createFetchStub(async () => {
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
									'data: {"choices":[{"delta":{"content":"GitHub"}}]}\n\n' +
									"data: [DONE]\n\n",
							),
						);
						controller.close();
					},
				});
				return new Response(stream, { status: 200 });
			}),
		});

		const chunks = [];
		const stream = provider.stream;
		if (!stream) {
			throw new Error("Expected GitHub provider stream support.");
		}
		for await (const chunk of stream({
			phase: "respond",
			prompt: "hello",
			tools: [],
			toolResults: [],
		} satisfies AgenticLLMResponseRequest)) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([
			{ phase: "respond", delta: "Hello ", content: "Hello " },
			{ phase: "respond", delta: "GitHub", content: "Hello GitHub" },
		]);
	});
});

function createFetchStub(
	handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		return handler(input, init);
	}) as typeof fetch;
}
