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
	/**
	 * Covers the main non-streaming client flow.
	 *
	 * This is useful because the browser SDK must generate or preserve a
	 * conversation id, expose state updates, and normalize a completed backend
	 * response into a stable local state snapshot.
	 */
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
						content: "# Dashboard",
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
		expect(response.content).toBe("# Dashboard");
		expect(observedStatuses).toEqual(["idle", "running", "completed"]);
		expect(client.getState()).toMatchObject({
			status: "completed",
			conversationId: "flow-thread-1",
			activePrompt: "Show the sales dashboard",
			content: "# Dashboard",
			toolCalls: [],
		});
	});

	/**
	 * Covers the streaming state machine exposed by the client SDK.
	 *
	 * This is useful because frontend code needs accumulated content, planned tool
	 * calls, executed tool results, and a final completed state without manually
	 * rebuilding the router's event contract.
	 */
	it("tracks tool activity and content during streaming", async () => {
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
					type: "render",
					delta: "Hello ",
					content: "Hello ",
				};
				yield {
					type: "render",
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
			"render",
			"render",
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

	/**
	 * Covers correction resume ergonomics in the client SDK.
	 *
	 * This is useful because the main value of the browser client is hiding the
	 * raw pause/resume payload juggling while still sending the backend enough
	 * information to preserve the audit trail.
	 */
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
		expect(client.getState()).toMatchObject({
			status: "completed",
			pendingCorrection: undefined,
			content: "User created",
		});
	});
});

describe("createFetchAgenticFlowTransport", () => {
	/**
	 * Covers fetch-based transport parsing for both buffered and streamed flows.
	 *
	 * This is useful because downstream apps will usually use the default fetch
	 * transport, and it must handle raw router payloads as well as SSE event
	 * envelopes without extra adapter code.
	 */
	it("posts run, stream, and reset requests against a proxy endpoint", async () => {
		const seenRequests: Array<{
			url: string;
			method?: string;
			accept?: string | null;
			body: string;
		}> = [];
		const transport = createFetchAgenticFlowTransport({
			baseUrl: "https://example.com/api/agentic",
			resetPath: "reset",
			fetchImplementation: (async (input, init) => {
				const headers = new Headers(init?.headers);
				seenRequests.push({
					url: String(input),
					method: init?.method,
					accept: headers.get("accept"),
					body: String(init?.body ?? ""),
				});

				if (String(input).endsWith("/stream")) {
					return new Response(
						createSSEStream([
							JSON.stringify({
								event: {
									type: "render",
									delta: "Hello ",
									content: "Hello ",
								},
							}),
							JSON.stringify({
								event: {
									type: "done",
									response: createResponse({
										prompt: "hello",
										content: "Hello world",
									}),
								},
							}),
							"[DONE]",
						]),
						{
							status: 200,
							headers: { "content-type": "text/event-stream" },
						},
					);
				}

				if (String(input).endsWith("/reset")) {
					return new Response(null, { status: 204 });
				}

				return new Response(
					JSON.stringify(
						createResponse({
							prompt: "hello",
							content: "Buffered hello",
						}),
					),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}) as typeof fetch,
		});

		const runResponse = await transport.run({
			prompt: "hello",
			conversationId: "proxy-thread",
		});
		const streamedEvents: AgenticRouterStreamEvent[] = [];

		for await (const event of transport.stream?.({
			prompt: "hello",
			conversationId: "proxy-thread",
		}) ?? []) {
			streamedEvents.push(event.event);
		}

		await transport.reset?.({ conversationId: "proxy-thread" });

		expect(runResponse.response.content).toBe("Buffered hello");
		expect(streamedEvents.map((event) => event.type)).toEqual([
			"render",
			"done",
		]);
		expect(seenRequests).toEqual([
			{
				url: "https://example.com/api/agentic/run",
				method: "POST",
				accept: null,
				body: JSON.stringify({
					prompt: "hello",
					conversationId: "proxy-thread",
				}),
			},
			{
				url: "https://example.com/api/agentic/stream",
				method: "POST",
				accept: "text/event-stream",
				body: JSON.stringify({
					prompt: "hello",
					conversationId: "proxy-thread",
				}),
			},
			{
				url: "https://example.com/api/agentic/reset",
				method: "POST",
				accept: null,
				body: JSON.stringify({
					conversationId: "proxy-thread",
				}),
			},
		]);
	});
});

function createResponse(
	input: Partial<AgenticRouterResponse> & {
		prompt: string;
		content: string;
		toolCalls?: AgenticRouterResponse["toolCalls"];
	},
): AgenticRouterResponse {
	return {
		status: input.status ?? "completed",
		model: input.model ?? "sdk-test-model",
		format: input.format ?? "markdown",
		prompt: input.prompt,
		systemInstruction: input.systemInstruction,
		content: input.content,
		toolCalls: input.toolCalls ?? [],
		iterations: input.iterations ?? 1,
		pendingCorrection: input.pendingCorrection,
	};
}

function createPendingCorrection(): AgenticPendingCorrection {
	return {
		reason: "validation-required",
		message: "I need more information before I can run create_user.",
		toolCall: {
			toolName: "create_user",
			rationale: "A user creation tool is required.",
			arguments: { role: "admin" },
		},
		fields: [{ name: "name", message: "Required" }],
		originalPrompt: "Create a new admin user",
		iteration: 1,
	};
}

function createNeedsInputResponse(
	prompt: string,
	pendingCorrection: AgenticPendingCorrection,
): AgenticRouterResponse {
	return createResponse({
		status: "needs-user-input",
		prompt,
		content: pendingCorrection.message,
		pendingCorrection,
	});
}

function createSSEStream(messages: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const message of messages) {
				controller.enqueue(new TextEncoder().encode(`data: ${message}\n\n`));
			}

			controller.close();
		},
	});
}
