import { describe, expect, it } from "bun:test";
import {
	AgenticRouter,
	createInMemoryHistoryProvider,
	type AgenticLLMProvider,
	z,
} from "../index";

describe("AgenticRouter", () => {
	it("returns a plain-text summary when no tool call is required", async () => {
		const router = new AgenticRouter({ model: "mock-test" });

		const response = await router.runAndRespond(
			"   show me a plain summary   ",
		);

		expect(response.model).toBe("mock-test");
		expect(response.prompt).toBe("show me a plain summary");
		expect(response.toolCalls).toHaveLength(0);
		expect(response.content).toContain("Prompt: show me a plain summary");
		expect(response.content).toContain(
			"No tool call was required for this prompt.",
		);
	});

	it("executes a matching tool and returns a grounded summary", async () => {
		const router = new AgenticRouter({ model: "mock-test" });
		let observedContext:
			| {
					iteration: number;
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
					toolResultsLength: context.toolResults.length,
				};

				return {
					items: [
						{ id: "sku-travel-1", query: input.query, limit: input.limit },
					],
				};
			},
		);

		const response = await router.runAndRespond(
			"Please search_catalog query: travel laptop, limit: 3",
			"Return a compact factual summary.",
		);

		expect(response.toolCalls).toHaveLength(1);
		expect(response.toolCalls[0]?.toolName).toBe("search_catalog");
		expect(response.toolCalls[0]?.arguments).toEqual({
			query: "travel laptop",
			limit: 3,
		});
		expect(response.content).toContain("Completed 1 tool call(s).");
		expect(response.content).toContain("search_catalog");
		expect(response.content).toContain('"query":"travel laptop"');
		expect(observedContext).toEqual({ iteration: 1, toolResultsLength: 0 });
	});

	it("supports a responseResolver shortcut before the provider response phase", async () => {
		const seenPhases: string[] = [];
		const provider: AgenticLLMProvider = {
			name: "counting-provider",
			model: "counting-model",
			request: async (request) => {
				seenPhases.push(request.phase);
				return request.phase === "plan"
					? { phase: "plan", toolCalls: [] }
					: { phase: "respond", content: "provider fallback" };
			},
		};
		const router = new AgenticRouter({
			provider,
			responseResolver: async (request) => ({
				phase: request.phase,
				content: `resolver summary for ${request.prompt}`,
			}),
		});

		const response = await router.runAndRespond("resolver path");

		expect(response.content).toBe("resolver summary for resolver path");
		expect(seenPhases).toEqual(["plan"]);
	});

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
					phase: "respond",
					content:
						request.conversationHistory?.length === 0
							? "No prior history"
							: `History length ${request.conversationHistory?.length}`,
				};
			},
		};

		const router = new AgenticRouter({ provider, historyProvider });

		const firstResponse = await router.runAndRespond(
			"show the current employees",
			undefined,
			{ conversationId: "hr-team" },
		);
		const secondResponse = await router.runAndRespond(
			"increase Karim salary by 1000 more",
			undefined,
			{ conversationId: "hr-team" },
		);
		const storedHistory = await historyProvider.get("hr-team");

		expect(firstResponse.content).toBe("No prior history");
		expect(secondResponse.content).toBe("History length 2");
		expect(observedHistoryLengths).toEqual([0, 0, 2, 2]);
		expect(storedHistory).toHaveLength(4);
	});

	it("streams response events after tool execution", async () => {
		const provider: AgenticLLMProvider = {
			name: "stream-provider",
			model: "stream-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					return {
						phase: "plan",
						toolCalls: [
							{
								toolName: "lookup_weather",
								rationale: "Need live weather data.",
								arguments: { city: "Paris" },
							},
						],
					};
				}

				return { phase: "respond", content: "Buffered summary" };
			},
			stream: async function* () {
				yield { phase: "respond", delta: "Hello ", content: "Hello " };
				yield { phase: "respond", delta: "Paris", content: "Hello Paris" };
			},
		};

		const router = new AgenticRouter({ provider, useStreaming: true });
		router.registerTool(
			"lookup_weather",
			"Look up weather for a city.",
			z.object({ city: z.string().min(2) }),
			async ({ city }) => ({ city, temperature: 21 }),
		);

		const events = [];
		for await (const event of router.runAndRespondStream("weather in paris")) {
			events.push(event);
		}

		expect(events.map((event) => event.type)).toEqual([
			"tool-call",
			"tool-result",
			"response",
			"response",
			"done",
		]);
		expect(events[2]).toMatchObject({
			type: "response",
			delta: "Hello ",
			content: "Hello ",
		});
		expect(events[4]).toMatchObject({
			type: "done",
			response: {
				content: "Hello Paris",
			},
		});
	});

	it("pauses for missing tool input and resumes with plain-text correction messaging", async () => {
		let planCalls = 0;
		const provider: AgenticLLMProvider = {
			name: "correction-provider",
			model: "correction-v1",
			request: async (request) => {
				if (request.phase === "plan") {
					planCalls += 1;
					if (planCalls === 1) {
						return {
							phase: "plan",
							toolCalls: [
								{
									toolName: "create_user",
									rationale: "Need to create the user.",
									arguments: {},
								},
							],
						};
					}

					return { phase: "plan", toolCalls: [] };
				}

				return { phase: "respond", content: "User created for Alice Martin" };
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
		});
		router.registerTool(
			"create_user",
			"Create a new admin user.",
			z.object({ name: z.string().min(2) }),
			async ({ name }) => ({ name, status: "created" }),
		);

		const paused = await router.runAndRespond("Create a new admin user");
		expect(paused.status).toBe("needs-user-input");
		expect(paused.content).toContain("Additional input required.");
		expect(paused.pendingCorrection?.fields[0]?.name).toBe("name");
		const pendingCorrection = paused.pendingCorrection;
		if (!pendingCorrection) {
			throw new Error("Expected pendingCorrection to be defined.");
		}

		const resumed = await router.runAndRespond("Alice Martin", undefined, {
			correctionAnswer: {
				pendingCorrection,
				values: { name: "Alice Martin" },
			},
		});

		expect(resumed.status).toBe("completed");
		expect(resumed.toolCalls[0]?.result).toEqual({
			name: "Alice Martin",
			status: "created",
		});
		expect(resumed.content).toBe("User created for Alice Martin");
	});

	it("triggers interactive correction when planner returns no tool call but required params are missing", async () => {
		const phases: string[] = [];
		const provider: AgenticLLMProvider = {
			name: "guardrail-provider",
			model: "guardrail-v1",
			request: async (request) => {
				phases.push(request.phase);
				return request.phase === "plan"
					? { phase: "plan", toolCalls: [] }
					: {
							phase: "respond",
							content:
								"Please provide the missing fields in a regular response.",
						};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
		});

		router.registerTool(
			"create_user",
			"Create a new user record.",
			z.object({
				name: z.string().min(2),
				email: z.string().email(),
			}),
			async ({ name, email }) => ({ created: true, name, email }),
		);

		const response = await router.runAndRespond("create user for Alice");

		expect(response.status).toBe("needs-user-input");
		expect(response.content).toContain("Additional input required.");
		expect(response.pendingCorrection?.toolCall.toolName).toBe("create_user");
		expect(
			response.pendingCorrection?.fields.map((field) => field.name),
		).toEqual(["name", "email"]);
		expect(phases).toEqual(["plan"]);
	});

	it("blocks invented required mutation arguments and asks for explicit values", async () => {
		const phases: string[] = [];
		const provider: AgenticLLMProvider = {
			name: "invented-args-provider",
			model: "invented-args-v1",
			request: async (request) => {
				phases.push(request.phase);

				return request.phase === "plan"
					? {
							phase: "plan",
							toolCalls: [
								{
									toolName: "create_user",
									rationale: "Need to create a user.",
									arguments: {
										name: "John Doe",
										email: "john.doe@example.com",
									},
								},
							],
						}
					: {
							phase: "respond",
							content: "Created user John Doe.",
						};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
		});

		router.registerTool(
			"create_user",
			"Create a new user record in the employee directory.",
			z.object({
				name: z.string().min(2),
				email: z.string().email(),
			}),
			async ({ name, email }) => ({ created: true, name, email }),
			{
				isMutation: true,
			},
		);

		const response = await router.runAndRespond("create a new employee");

		expect(response.status).toBe("needs-user-input");
		expect(response.content).toContain("Additional input required.");
		expect(response.pendingCorrection?.toolCall.toolName).toBe("create_user");
		expect(response.pendingCorrection?.toolCall.arguments).toEqual({});
		expect(
			response.pendingCorrection?.fields.map((field) => field.name),
		).toEqual(["name", "email"]);
		expect(phases).toEqual(["plan"]);
	});

	it("triggers correction for 'create an employee' even when planner returns no tool calls", async () => {
		const provider: AgenticLLMProvider = {
			name: "no-tool-provider",
			model: "no-tool-v1",
			request: async (request) => {
				return request.phase === "plan"
					? { phase: "plan", toolCalls: [] }
					: {
							phase: "respond",
							content: "No action required.",
						};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
		});

		router.registerTool(
			"list_employees",
			"List employees in the HR system.",
			z.object({
				department: z.string().optional(),
			}),
			async () => ({ employees: [] }),
		);

		router.registerTool(
			"add_employee",
			"Add a new employee to the HR system.",
			z.object({
				name: z.string().min(2),
				role: z.string().min(2),
				salary: z.number().positive(),
			}),
			async ({ name, role, salary }) => ({ created: true, name, role, salary }),
			{
				isMutation: true,
			},
		);

		const response = await router.runAndRespond("create an employee");

		expect(response.status).toBe("needs-user-input");
		expect(response.pendingCorrection?.toolCall.toolName).toBe("add_employee");
		expect(
			response.pendingCorrection?.fields.map((field) => field.name),
		).toEqual(["name", "role", "salary"]);
	});

	it("supports non-English mutation intent via tool intentKeywords", async () => {
		const provider: AgenticLLMProvider = {
			name: "multilingual-no-tool-provider",
			model: "multilingual-no-tool-v1",
			request: async (request) => {
				return request.phase === "plan"
					? { phase: "plan", toolCalls: [] }
					: {
							phase: "respond",
							content: "No action required.",
						};
			},
		};

		const router = new AgenticRouter({
			provider,
			enableInteractiveCorrections: true,
		});

		router.registerTool(
			"add_employee",
			"Add a new employee to the HR system.",
			z.object({
				name: z.string().min(2),
				role: z.string().min(2),
				salary: z.number().positive(),
			}),
			async ({ name, role, salary }) => ({ created: true, name, role, salary }),
			{
				isMutation: true,
				intentKeywords: ["crear", "empleado"],
			},
		);

		const response = await router.runAndRespond("crear un empleado");

		expect(response.status).toBe("needs-user-input");
		expect(response.pendingCorrection?.toolCall.toolName).toBe("add_employee");
		expect(
			response.pendingCorrection?.fields.map((field) => field.name),
		).toEqual(["name", "role", "salary"]);
	});
});
