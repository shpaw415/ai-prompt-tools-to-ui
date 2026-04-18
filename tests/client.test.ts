import { describe, expect, it } from "bun:test";
import {
	AgenticFlowClient,
	createFetchAgenticFlowTransport,
	type AgenticFlowTransport,
	type AgenticPendingCorrection,
	type AgenticRouterResponse,
	type AgenticRouterStreamEvent,
} from "../client";

describe("AgenticFlowClient", () => {
	it("runs a request and updates local flow state", async () => {
		const requests: Array<{ prompt: string; conversationId?: string }> = [];
		const transport: AgenticFlowTransport = {
			async run(request) {
				requests.push({
					prompt: request.prompt,
					conversationId: request.conversationId,
				});

				return {
					conversationId: request.conversationId,
					response: createResponse({
						prompt: request.prompt,
						content: "Sales dashboard summary",
					}),
				};
			},
		};

		const client = new AgenticFlowClient({
			transport,
			createConversationId: () => "flow-thread-1",
		});
		const observedStatuses: string[] = [];

		client.subscribe((state) => {
			observedStatuses.push(state.status);
		});

		const response = await client.run("Show the sales dashboard");

		expect(requests).toEqual([
			{ prompt: "Show the sales dashboard", conversationId: "flow-thread-1" },
		]);
		expect(response.content).toBe("Sales dashboard summary");
		expect(observedStatuses).toEqual(["idle", "running", "completed"]);
		expect(client.getState()).toMatchObject({
			status: "completed",
			conversationId: "flow-thread-1",
			activePrompt: "Show the sales dashboard",
			content: "Sales dashboard summary",
			toolCalls: [],
		});
	});

	it("tracks tool activity and response chunks during streaming", async () => {
		const events: AgenticRouterStreamEvent[] = [];
		const transport: AgenticFlowTransport = {
			async run() {
				throw new Error("run should not be used in this test");
			},
			async *stream(request) {
				yield {
					conversationId: request.conversationId,
					event: {
						type: "tool-call",
						iteration: 1,
						toolCall: {
							toolName: "lookup_weather",
							rationale: "Need live weather data.",
							arguments: { city: "Paris" },
						},
					},
				};
				yield {
					type: "tool-result",
					iteration: 1,
					result: {
						toolName: "lookup_weather",
						rationale: "Need live weather data.",
						arguments: { city: "Paris" },
						result: { city: "Paris", temperature: 21 },
						durationMs: 8,
					},
				};
				yield {
					type: "response",
					delta: "Hello ",
					content: "Hello ",
				};
				yield {
					type: "response",
					delta: "Paris",
					content: "Hello Paris",
				};
				yield {
					type: "done",
					response: createResponse({
						prompt: request.prompt,
						content: "Hello Paris",
						toolCalls: [
							{
								toolName: "lookup_weather",
								rationale: "Need live weather data.",
								arguments: { city: "Paris" },
								result: { city: "Paris", temperature: 21 },
								durationMs: 8,
							},
						],
					}),
				};
			},
		};

		const client = new AgenticFlowClient({
			transport,
			conversationId: "stream-thread",
		});

		for await (const event of client.stream("Weather in Paris")) {
			events.push(event);
		}

		expect(events.map((event) => event.type)).toEqual([
			"tool-call",
			"tool-result",
			"response",
			"response",
			"done",
		]);
		expect(client.getState()).toMatchObject({
			status: "completed",
			conversationId: "stream-thread",
			content: "Hello Paris",
			plannedToolCalls: [
				{
					toolName: "lookup_weather",
					arguments: { city: "Paris" },
				},
			],
			toolCalls: [
				{
					toolName: "lookup_weather",
					result: { city: "Paris", temperature: 21 },
				},
			],
		});
	});

	it("resumes a pending correction with a derived prompt and correction payload", async () => {
		const requests: Array<{
			prompt: string;
			conversationId?: string;
			correctionAnswer?: {
				confirmed?: boolean;
				values?: Record<string, unknown>;
			};
		}> = [];
		const pendingCorrection = createPendingCorrection();
		const transport: AgenticFlowTransport = {
			async run(request) {
				requests.push({
					prompt: request.prompt,
					conversationId: request.conversationId,
					correctionAnswer: request.correctionAnswer
						? {
								confirmed: request.correctionAnswer.confirmed,
								values: request.correctionAnswer.values,
							}
						: undefined,
				});

				if (!request.correctionAnswer) {
					return {
						conversationId: request.conversationId,
						response: createNeedsInputResponse(
							request.prompt,
							pendingCorrection,
						),
					};
				}

				return {
					conversationId: request.conversationId,
					response: createResponse({
						prompt: pendingCorrection.originalPrompt,
						content: "User created",
					}),
				};
			},
		};

		const client = new AgenticFlowClient({
			transport,
			conversationId: "interactive-thread",
		});

		const first = await client.run("Create a new admin user");
		const resumed = await client.resumeCorrection({
			values: { name: "Alice Martin" },
		});

		expect(first.status).toBe("needs-user-input");
		expect(resumed.content).toBe("User created");
		expect(requests).toEqual([
			{
				prompt: "Create a new admin user",
				conversationId: "interactive-thread",
				correctionAnswer: undefined,
			},
			{
				prompt: "Alice Martin",
				conversationId: "interactive-thread",
				correctionAnswer: {
					confirmed: undefined,
					values: { name: "Alice Martin" },
				},
			},
		]);
	});
});

describe("createFetchAgenticFlowTransport", () => {
	it("supports relative proxy base URLs in browser-style setups", async () => {
		const seenUrls: string[] = [];
		const transport = createFetchAgenticFlowTransport({
			baseUrl: "/api/agentic",
			fetchImplementation: (async (input) => {
				seenUrls.push(String(input));

				return new Response(
					JSON.stringify(
						createResponse({ prompt: "hello", content: "Proxy response" }),
					),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as typeof fetch,
		});

		const response = await transport.run({ prompt: "hello" });

		expect(seenUrls).toEqual(["/api/agentic/run"]);
		expect(response.response.content).toBe("Proxy response");
	});

	it("uses the default reset endpoint when resetPath is not provided", async () => {
		const seenUrls: string[] = [];
		const transport = createFetchAgenticFlowTransport({
			baseUrl: "/api/agentic",
			fetchImplementation: (async (input) => {
				seenUrls.push(String(input));

				return new Response(null, { status: 204 });
			}) as typeof fetch,
		});

		await transport.reset?.({ conversationId: "thread-1" });

		expect(seenUrls).toEqual(["/api/agentic/reset"]);
	});
});

function createResponse(
	overrides: Partial<AgenticRouterResponse> &
		Pick<AgenticRouterResponse, "prompt" | "content">,
): AgenticRouterResponse {
	return {
		status: "completed",
		model: "test-model",
		prompt: overrides.prompt,
		systemInstruction: overrides.systemInstruction,
		content: overrides.content,
		toolCalls: overrides.toolCalls ?? [],
		iterations: overrides.iterations ?? 1,
		pendingCorrection: overrides.pendingCorrection,
	};
}

function createNeedsInputResponse(
	prompt: string,
	pendingCorrection: AgenticPendingCorrection,
): AgenticRouterResponse {
	return {
		status: "needs-user-input",
		model: "test-model",
		prompt,
		content: "Additional input required.",
		toolCalls: [],
		iterations: 1,
		pendingCorrection,
	};
}

function createPendingCorrection(): AgenticPendingCorrection {
	return {
		reason: "validation-required",
		message: "Please provide a name.",
		toolCall: {
			toolName: "create_user",
			rationale: "Need the name to create the user.",
			arguments: {},
		},
		fields: [{ name: "name", message: "Required", valueType: "string" }],
		originalPrompt: "Create a new admin user",
		iteration: 1,
	};
}
