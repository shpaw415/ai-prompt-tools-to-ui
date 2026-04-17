import { describe, expect, it } from "bun:test";
import { type AgenticLLMProvider, AgenticRouter, z } from "../index";

describe("AgenticRouter", () => {
	/**
	 * Covers the no-tool path and prompt normalization contract.
	 *
	 * This is useful because the router must still return renderable UI when the
	 * planner cannot match any tool, and callers should receive the normalized
	 * prompt value rather than the raw whitespace-padded input.
	 */
	it("returns markdown output without tool calls when no tool matches", async () => {
		const router = new AgenticRouter({ model: "mock-test" });

		const response = await router.runAndRender("   show me a plain summary   ");

		expect(response.model).toBe("mock-test");
		expect(response.format).toBe("markdown");
		expect(response.prompt).toBe("show me a plain summary");
		expect(response.toolCalls).toHaveLength(0);
		expect(response.content).toContain("# Agentic UI Response");
		expect(response.content).toContain(
			"No tool call was required for this prompt.",
		);
	});

	/**
	 * Covers the main orchestration path: plan, validate, execute, and render.
	 *
	 * This is the highest-value behavior in the plugin because it proves that a
	 * registered tool is selected from the prompt, receives Zod-validated inputs,
	 * observes the execution context, and contributes to the final rendered UI.
	 */
	it("executes a matching tool and renders its result in markdown", async () => {
		const router = new AgenticRouter({ model: "mock-test" });
		let observedContext:
			| {
					iteration: number;
					outputFormat: string;
					toolResultsLength: number;
			  }
			| undefined;

		router.registerTool(
			"search_catalog",
			"Search the internal catalog for matching products.",
			z.object({
				query: z.string().min(3),
				limit: z.number().int().positive().optional(),
			}),
			async (input, context) => {
				observedContext = {
					iteration: context.iteration,
					outputFormat: context.outputFormat,
					toolResultsLength: context.toolResults.length,
				};

				return {
					items: [
						{
							id: "sku-travel-1",
							query: input.query,
							limit: input.limit ?? null,
						},
					],
				};
			},
		);

		const response = await router.runAndRender(
			"Please search_catalog query: travel laptop, limit: 3",
			"Return a compact result card.",
		);

		expect(response.toolCalls).toHaveLength(1);
		expect(response.toolCalls[0]?.toolName).toBe("search_catalog");
		expect(response.toolCalls[0]?.arguments).toEqual({
			query: "travel laptop",
			limit: 3,
		});
		expect(response.content).toContain("## Tool: search_catalog");
		expect(response.content).toContain('"query": "travel laptop"');
		expect(observedContext).toEqual({
			iteration: 1,
			outputFormat: "markdown",
			toolResultsLength: 0,
		});
	});

	/**
	 * Covers the modular provider contract used to plug external SDKs into the router.
	 *
	 * This is useful because the plugin must not depend on a single LLM vendor.
	 * The test proves that a plain provider object with request/apiKey/client fields
	 * can drive planning and rendering while the router continues to own tool
	 * execution, validation, final response shaping, and iterative replanning.
	 */
	it("accepts a custom provider object for planning and rendering", async () => {
		const requests: string[] = [];
		const provider: AgenticLLMProvider<
			{ vendor: string },
			{ transport: string }
		> = {
			name: "custom-sdk-provider",
			model: "sdk-model-v1",
			apiKey: "test-key",
			client: { transport: "stub" },
			metadata: { vendor: "example-sdk" },
			request: async (request) => {
				requests.push(request.phase);

				if (request.phase === "plan") {
					return {
						phase: "plan",
						toolCalls: [
							{
								toolName: "lookup_weather",
								rationale: "Weather data is required to answer the prompt.",
								arguments: {
									city: "Paris",
									unit: "metric",
								},
							},
						],
					};
				}

				return {
					phase: "render",
					content: `Weather UI ${JSON.stringify(request.toolResults[0]?.result)}`,
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			outputFormat: "markdown",
		});

		router.registerTool(
			"lookup_weather",
			"Look up current weather for a city.",
			z.object({
				city: z.string().min(2),
				unit: z.enum(["metric", "imperial"]),
			}),
			async ({ city, unit }) => ({ city, unit, temperature: 21 }),
		);

		const response = await router.runAndRender("What is the weather in Paris?");

		expect(requests).toEqual(["plan", "plan", "render"]);
		expect(response.model).toBe("sdk-model-v1");
		expect(response.toolCalls).toHaveLength(1);
		expect(response.toolCalls[0]?.arguments).toEqual({
			city: "Paris",
			unit: "metric",
		});
		expect(response.content).toContain('"temperature":21');
	});

	/**
	 * Covers the explicit render styling contract passed from the router to the
	 * provider during the render phase.
	 *
	 * This is useful because callers may want a stable API for styling strategy
	 * selection instead of manually repeating Tailwind or CSS instructions in every
	 * system prompt.
	 */
	it("passes render styling preferences to the provider", async () => {
		let observedRenderRequest:
			| {
					renderStyle?: string;
					renderStyleInstruction?: string;
					outputFormat: string;
			  }
			| undefined;

		const provider: AgenticLLMProvider = {
			name: "styled-provider",
			model: "styled-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return { phase: "plan", toolCalls: [] };
				}

				observedRenderRequest = {
					renderStyle: request.renderStyle,
					renderStyleInstruction: request.renderStyleInstruction,
					outputFormat: request.outputFormat,
				};

				return {
					phase: "render",
					content: '<div class="p-6">Styled output</div>',
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			outputFormat: "html",
			renderStyle: "tailwind",
			renderStyleInstruction:
				"Prefer compact cards, strong headings, and subtle borders.",
		});

		const response = await router.runAndRender("show me plugin matches");

		expect(response.content).toContain("Styled output");
		expect(observedRenderRequest).toEqual({
			renderStyle: "tailwind",
			renderStyleInstruction:
				"Prefer compact cards, strong headings, and subtle borders.",
			outputFormat: "html",
		});
	});

	/**
	 * Covers the public streaming API of the router.
	 *
	 * This is useful because the agentic loop must still plan and execute tools
	 * before emitting incremental render chunks, and callers need a stable event
	 * contract that ends with a final completed response.
	 */
	it("streams render chunks after tool orchestration", async () => {
		const phases: string[] = [];
		const provider: AgenticLLMProvider = {
			name: "streaming-provider",
			model: "stream-v1",
			request: async (request) => {
				phases.push(request.phase);

				if (request.phase === "plan") {
					return request.toolResults.length === 0
						? {
								phase: "plan",
								toolCalls: [
									{
										toolName: "lookup_weather",
										rationale: "Weather lookup is required.",
										arguments: { city: "Paris" },
									},
								],
							}
						: { phase: "plan", toolCalls: [] };
				}

				return {
					phase: "render",
					content: "unused fallback",
				};
			},
			stream: async function* () {
				yield { phase: "render", delta: "Hello ", content: "Hello " };
				yield { phase: "render", delta: "Paris", content: "Hello Paris" };
			},
		};

		const router = new AgenticRouter({
			provider,
			outputFormat: "markdown",
			useStreaming: true,
		});

		router.registerTool(
			"lookup_weather",
			"Look up current weather for a city.",
			z.object({ city: z.string().min(2) }),
			async ({ city }) => ({ city, temperature: 21 }),
		);

		const events = [];
		for await (const event of router.runAndRenderStream("weather in paris")) {
			events.push(event);
		}

		expect(phases).toEqual(["plan", "plan"]);
		expect(events.map((event) => event.type)).toEqual([
			"tool-call",
			"tool-result",
			"render",
			"render",
			"done",
		]);
		expect(events[2]).toMatchObject({
			type: "render",
			delta: "Hello ",
			content: "Hello ",
		});
		expect(events[4]).toMatchObject({
			type: "done",
			response: {
				model: "stream-v1",
				content: "Hello Paris",
			},
		});
	});

	/**
	 * Covers the explicit `useStreaming` opt-in on the router.
	 *
	 * This is useful because providers may expose a `stream()` function, but the
	 * router should only use it when the caller deliberately enables streaming.
	 * Otherwise the stream API must degrade to a single buffered render chunk.
	 */
	it("falls back to buffered rendering when useStreaming is disabled", async () => {
		const phases: string[] = [];
		const provider: AgenticLLMProvider = {
			name: "conditional-stream-provider",
			model: "stream-v1",
			request: async (request) => {
				phases.push(request.phase);

				if (request.phase === "plan") {
					return { phase: "plan", toolCalls: [] };
				}

				return {
					phase: "render",
					content: "Buffered content",
				};
			},
			stream: async function* () {
				yield {
					phase: "render",
					delta: "Streaming content",
					content: "Streaming content",
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			outputFormat: "markdown",
			useStreaming: false,
		});

		const events = [];
		for await (const event of router.runAndRenderStream("render buffered")) {
			events.push(event);
		}

		expect(phases).toEqual(["plan", "render"]);
		expect(events).toMatchObject([
			{
				type: "render",
				delta: "Buffered content",
				content: "Buffered content",
			},
			{ type: "done", response: { content: "Buffered content" } },
		]);
	});

	/**
	 * Covers HTML rendering with hostile-looking dynamic values.
	 *
	 * This is useful because the generated UI can be injected into a renderer, so
	 * prompt content, system instructions, and tool payloads must be escaped before
	 * they are interpolated into HTML.
	 */
	it("escapes prompt, instructions, and tool data in html output", async () => {
		const router = new AgenticRouter({
			model: "mock-test",
			outputFormat: "html",
		});

		router.registerTool(
			"summarize_profile",
			"Summarize a user profile from a query.",
			z.object({
				query: z.string().min(1),
			}),
			async () => ({
				unsafe: '<script>alert("x")</script>',
			}),
		);

		const response = await router.runAndRender(
			"summarize_profile query: <b>Alice</b>",
			"Render <i>safely</i>",
		);

		expect(response.format).toBe("html");
		expect(response.content).toContain('<article class="agentic-ui">');
		expect(response.content).toContain("&lt;i&gt;safely&lt;/i&gt;");
		expect(response.content).toContain("&lt;b&gt;Alice&lt;/b&gt;");
		expect(response.content).toContain("&lt;script&gt;");
		expect(response.content).not.toContain("<script>");
	});

	/**
	 * Covers the two most important public guardrails on the router API.
	 *
	 * This is useful because duplicate tool identifiers create ambiguous planner
	 * state, and empty prompts should fail fast before any planning or rendering is
	 * attempted.
	 */
	it("rejects duplicate tool names and empty prompts", async () => {
		const router = new AgenticRouter({ model: "mock-test" });

		router.registerTool(
			"lookup_user",
			"Look up a user by name.",
			z.object({ name: z.string() }),
			async ({ name }) => ({ name }),
		);

		expect(() => {
			router.registerTool(
				"lookup_user",
				"Look up a user by name.",
				z.object({ name: z.string() }),
				async ({ name }) => ({ name }),
			);
		}).toThrow('Tool "lookup_user" is already registered.');

		await expect(router.runAndRender("   ")).rejects.toThrow(
			"Prompt must be a non-empty string.",
		);
	});
});
