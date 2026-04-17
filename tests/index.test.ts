import { describe, expect, it } from "bun:test";
import {
	createInMemoryHistoryProvider,
	type AgenticLLMProvider,
	AgenticRouter,
	z,
} from "../index";

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
	 * Covers persisted conversation history across multiple router runs.
	 *
	 * This is useful because follow-up prompts must be able to reference the prior
	 * conversation without replaying the full state manually on every call.
	 */
	it("persists conversation history between runs when a history provider is configured", async () => {
		const historyProvider = createInMemoryHistoryProvider();
		const observedHistoryLengths: number[] = [];
		const provider: AgenticLLMProvider = {
			name: "history-aware-provider",
			model: "history-v1",
			request: async (request) => {
				observedHistoryLengths.push(request.conversationHistory?.length ?? 0);

				if (request.phase === "plan") {
					return { phase: "plan", toolCalls: [] };
				}

				return {
					phase: "render",
					content:
						request.conversationHistory?.length === 0
							? "No prior history"
							: `History length ${request.conversationHistory?.length}`,
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			historyProvider,
			outputFormat: "markdown",
		});

		const firstResponse = await router.runAndRender(
			"show the current employees",
			undefined,
			{ conversationId: "hr-team" },
		);
		const secondResponse = await router.runAndRender(
			"increase Karim salary by 1000 more",
			undefined,
			{ conversationId: "hr-team" },
		);
		const storedHistory = await historyProvider.get("hr-team");

		expect(firstResponse.content).toBe("No prior history");
		expect(secondResponse.content).toBe("History length 2");
		expect(observedHistoryLengths).toEqual([0, 0, 2, 2]);
		expect(storedHistory).toHaveLength(4);
		expect(storedHistory.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(storedHistory[0]?.content).toBe("show the current employees");
		expect(storedHistory[2]?.content).toBe(
			"increase Karim salary by 1000 more",
		);
	});

	/**
	 * Covers history window trimming before each provider call.
	 *
	 * This is useful because persisted history can grow without bound, and the
	 * router needs a predictable way to keep prompts within a manageable size.
	 */
	it("trims persisted history to the configured window size", async () => {
		const historyProvider = createInMemoryHistoryProvider();
		const observedHistorySnapshots: string[][] = [];
		const provider: AgenticLLMProvider = {
			name: "trim-history-provider",
			model: "history-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return { phase: "plan", toolCalls: [] };
				}

				observedHistorySnapshots.push(
					(request.conversationHistory ?? []).map((message) => message.content),
				);

				return {
					phase: "render",
					content: "ok",
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			historyProvider,
			outputFormat: "markdown",
			historyWindowSize: 2,
		});

		await router.runAndRender("first prompt", undefined, {
			conversationId: "trimmed-thread",
		});
		await router.runAndRender("second prompt", undefined, {
			conversationId: "trimmed-thread",
		});
		await router.runAndRender("third prompt", undefined, {
			conversationId: "trimmed-thread",
		});

		expect(observedHistorySnapshots).toEqual([
			[],
			[
				"first prompt",
				"Delivered a markdown response without calling any tool.",
			],
			[
				"second prompt",
				"Delivered a markdown response without calling any tool.",
			],
		]);
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
	 * Covers persistence timing for the streaming API.
	 *
	 * This is useful because the router should not write a conversation turn until
	 * the final render has completed, otherwise partially streamed outputs could be
	 * persisted as if they were finished responses.
	 */
	it("saves streamed conversation history only after the final response is complete", async () => {
		const historyProvider = createInMemoryHistoryProvider();
		const provider: AgenticLLMProvider = {
			name: "history-stream-provider",
			model: "history-stream-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return { phase: "plan", toolCalls: [] };
				}

				return { phase: "render", content: "unused fallback" };
			},
			stream: async function* () {
				yield { phase: "render", delta: "Hello ", content: "Hello " };
				yield { phase: "render", delta: "team", content: "Hello team" };
			},
		};

		const router = new AgenticRouter({
			provider,
			historyProvider,
			outputFormat: "markdown",
			useStreaming: true,
		});

		const observedStoredLengths: number[] = [];
		for await (const event of router.runAndRenderStream(
			"show the current payroll",
			undefined,
			{ conversationId: "stream-thread" },
		)) {
			if (event.type === "render") {
				observedStoredLengths.push(
					(await historyProvider.get("stream-thread")).length,
				);
			}
		}

		const storedHistory = await historyProvider.get("stream-thread");

		expect(observedStoredLengths).toEqual([0, 0]);
		expect(storedHistory).toHaveLength(2);
		expect(storedHistory[0]?.content).toBe("show the current payroll");
		expect(storedHistory[1]?.content).toContain(
			"Delivered a markdown response without calling any tool.",
		);
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
	 * Covers the interactive correction flow for missing tool arguments.
	 *
	 * This is useful because the planner may identify the right tool before it has
	 * every required field, and the router must pause instead of guessing values.
	 */
	it("pauses and asks for missing tool inputs when interactive corrections are enabled", async () => {
		let handlerCalls = 0;
		const provider: AgenticLLMProvider = {
			name: "interactive-correction-provider",
			model: "interactive-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return request.toolResults.length === 0
						? {
								phase: "plan",
								toolCalls: [
									{
										toolName: "create_user",
										rationale: "A user creation tool is required.",
										arguments: { role: "admin" },
									},
								],
							}
						: { phase: "plan", toolCalls: [] };
				}

				return {
					phase: "render",
					content: `Created UI ${JSON.stringify(request.toolResults[0]?.result)}`,
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
			outputFormat: "markdown",
		});

		router.registerTool(
			"create_user",
			"Create a user account.",
			z.object({
				name: z.string().min(2),
				role: z.string().min(2),
			}),
			async (input) => {
				handlerCalls += 1;
				return input;
			},
		);

		const response = await router.runAndRender("Create a new admin user");

		expect(response.status).toBe("needs-user-input");
		expect(response.pendingCorrection?.reason).toBe("validation-required");
		expect(response.pendingCorrection?.fields).toEqual([
			{
				name: "name",
				message: expect.any(String),
			},
		]);
		expect(response.content).toContain("Additional Input Required");
		expect(handlerCalls).toBe(0);
	});

	/**
	 * Covers resuming a paused tool execution after the caller provides the missing values.
	 *
	 * This is useful because the router must continue deterministically from the
	 * pending tool call instead of re-asking the LLM to reconstruct the same step.
	 */
	it("resumes a paused tool call after the client provides missing values", async () => {
		const provider: AgenticLLMProvider = {
			name: "interactive-resume-provider",
			model: "interactive-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return request.toolResults.length === 0
						? {
								phase: "plan",
								toolCalls: [
									{
										toolName: "create_user",
										rationale: "A user creation tool is required.",
										arguments: { role: "admin" },
									},
								],
							}
						: { phase: "plan", toolCalls: [] };
				}

				return {
					phase: "render",
					content: `Created UI ${JSON.stringify(request.toolResults[0]?.result)}`,
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
			outputFormat: "markdown",
		});

		router.registerTool(
			"create_user",
			"Create a user account.",
			z.object({
				name: z.string().min(2),
				role: z.string().min(2),
			}),
			async (input) => input,
		);

		const paused = await router.runAndRender("Create a new admin user");

		if (!paused.pendingCorrection) {
			throw new Error("Expected a pending correction payload.");
		}

		const resumed = await router.runAndRender("Alice Martin", undefined, {
			correctionAnswer: {
				pendingCorrection: paused.pendingCorrection,
				values: { name: "Alice Martin" },
			},
		});

		expect(resumed.status).toBe("completed");
		expect(resumed.prompt).toBe("Create a new admin user");
		expect(resumed.toolCalls).toHaveLength(1);
		expect(resumed.toolCalls[0]?.arguments).toEqual({
			name: "Alice Martin",
			role: "admin",
		});
		expect(resumed.content).toContain("Alice Martin");
	});

	/**
	 * Covers confirmation pauses for sensitive tools.
	 *
	 * This is useful because destructive actions should be able to stop for an
	 * explicit client-side confirmation before the handler runs.
	 */
	it("requires explicit confirmation before executing a sensitive tool", async () => {
		let removedEmployee = "";
		const provider: AgenticLLMProvider = {
			name: "confirmation-provider",
			model: "interactive-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return request.toolResults.length === 0
						? {
								phase: "plan",
								toolCalls: [
									{
										toolName: "remove_user",
										rationale: "The user asked for a deletion.",
										arguments: { name: "Karim" },
									},
								],
							}
						: { phase: "plan", toolCalls: [] };
				}

				return {
					phase: "render",
					content: `Removed ${JSON.stringify(request.toolResults[0]?.result)}`,
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
			outputFormat: "markdown",
		});

		router.registerTool(
			"remove_user",
			"Remove a user account.",
			z.object({
				name: z.string().min(2),
			}),
			async ({ name }) => {
				removedEmployee = name;
				return { removed: name };
			},
			{
				requiresConfirmation: true,
				confirmationMessage:
					'Please confirm that you want to delete the user "Karim".',
				confirmationKey: "delete-user",
			},
		);

		const paused = await router.runAndRender("Remove Karim");

		expect(paused.status).toBe("needs-user-input");
		expect(paused.pendingCorrection?.reason).toBe("confirmation-required");
		expect(paused.pendingCorrection?.confirmationKey).toBe("delete-user");
		expect(removedEmployee).toBe("");

		if (!paused.pendingCorrection) {
			throw new Error("Expected a pending correction payload.");
		}

		const resumed = await router.runAndRender("Yes, continue", undefined, {
			correctionAnswer: {
				pendingCorrection: paused.pendingCorrection,
				confirmed: true,
			},
		});

		expect(resumed.status).toBe("completed");
		expect(removedEmployee).toBe("Karim");
		expect(resumed.content).toContain("Karim");
	});

	/**
	 * Covers history persistence for paused and resumed interactive corrections.
	 *
	 * This is useful because multi-request correction flows should leave a clear
	 * conversation trail when a history provider is configured.
	 */
	it("persists pause and resume turns in conversation history during corrections", async () => {
		const historyProvider = createInMemoryHistoryProvider();
		const provider: AgenticLLMProvider = {
			name: "interactive-history-provider",
			model: "interactive-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return request.toolResults.length === 0
						? {
								phase: "plan",
								toolCalls: [
									{
										toolName: "create_user",
										rationale: "A user creation tool is required.",
										arguments: { role: "admin" },
									},
								],
							}
						: { phase: "plan", toolCalls: [] };
				}

				return {
					phase: "render",
					content: `Created UI ${JSON.stringify(request.toolResults[0]?.result)}`,
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			historyProvider,
			enableInteractiveCorrections: true,
			outputFormat: "markdown",
		});

		router.registerTool(
			"create_user",
			"Create a user account.",
			z.object({
				name: z.string().min(2),
				role: z.string().min(2),
			}),
			async (input) => input,
		);

		const paused = await router.runAndRender(
			"Create a new admin user",
			undefined,
			{ conversationId: "interactive-thread" },
		);

		if (!paused.pendingCorrection) {
			throw new Error("Expected a pending correction payload.");
		}

		const storedAfterPause = await historyProvider.get("interactive-thread");

		expect(storedAfterPause).toHaveLength(2);
		expect(storedAfterPause[0]?.content).toBe("Create a new admin user");
		expect(storedAfterPause[1]?.content).toContain(
			"I need more information before I can run create_user.",
		);

		await router.runAndRender("Alice Martin", undefined, {
			conversationId: "interactive-thread",
			correctionAnswer: {
				pendingCorrection: paused.pendingCorrection,
				values: { name: "Alice Martin" },
			},
		});

		const storedAfterResume = await historyProvider.get("interactive-thread");

		expect(storedAfterResume).toHaveLength(4);
		expect(storedAfterResume[2]?.content).toBe("Alice Martin");
		expect(storedAfterResume[3]?.content).toContain(
			"Delivered a markdown response using the following tool results:",
		);
	});

	/**
	 * Covers the stream contract when interactive input is required.
	 *
	 * This is useful because clients using the streaming API need a stable pause
	 * event instead of a partial final render when more user input is required.
	 */
	it("emits a needs-user-input stream event and stops before rendering", async () => {
		const provider: AgenticLLMProvider = {
			name: "interactive-stream-provider",
			model: "interactive-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return {
						phase: "plan",
						toolCalls: [
							{
								toolName: "create_user",
								rationale: "A user creation tool is required.",
								arguments: { role: "admin" },
							},
						],
					};
				}

				return {
					phase: "render",
					content: "This should not render.",
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
			useStreaming: true,
			outputFormat: "markdown",
		});

		router.registerTool(
			"create_user",
			"Create a user account.",
			z.object({
				name: z.string().min(2),
				role: z.string().min(2),
			}),
			async (input) => input,
		);

		const eventTypes: string[] = [];
		for await (const event of router.runAndRenderStream(
			"Create a new admin user",
		)) {
			eventTypes.push(event.type);
		}

		expect(eventTypes).toEqual(["tool-call", "needs-user-input"]);
	});

	/**
	 * Covers backward compatibility when interactive corrections are disabled.
	 *
	 * This is useful because existing callers should keep the current strict
	 * validation behavior unless they explicitly opt into the pause/resume flow.
	 */
	it("keeps strict validation behavior when interactive corrections are disabled", async () => {
		const provider: AgenticLLMProvider = {
			name: "strict-validation-provider",
			model: "strict-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return {
						phase: "plan",
						toolCalls: [
							{
								toolName: "create_user",
								rationale: "A user creation tool is required.",
								arguments: { role: "admin" },
							},
						],
					};
				}

				return {
					phase: "render",
					content: "unused",
				};
			},
		};

		const router = new AgenticRouter({
			provider,
			outputFormat: "markdown",
		});

		router.registerTool(
			"create_user",
			"Create a user account.",
			z.object({
				name: z.string().min(2),
				role: z.string().min(2),
			}),
			async (input) => input,
		);

		await expect(
			router.runAndRender("Create a new admin user"),
		).rejects.toThrow();
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
