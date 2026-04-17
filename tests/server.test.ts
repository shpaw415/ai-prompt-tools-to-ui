import { describe, expect, it } from "bun:test";
import type { AgenticCorrectionAnswer, AgenticRouterResponse } from "../index";
import {
	createAgenticFlowEventStream,
	createAgenticFlowServerAdapter,
	createAgenticFlowWebHandlers,
} from "../server";

describe("createAgenticFlowServerAdapter", () => {
	/**
	 * Covers the main server-side run adapter contract.
	 *
	 * This is useful because a thin adapter only adds value if it forwards the
	 * client transport payload to the router without changing the existing router
	 * behavior or leaking framework concerns into the core flow.
	 */
	it("maps a flow run request directly onto the router", async () => {
		const observedCalls: Array<{
			prompt: string;
			systemInstruction?: string;
			conversationId?: string;
			correctionAnswer?: AgenticCorrectionAnswer;
		}> = [];
		const adapter = createAgenticFlowServerAdapter({
			router: {
				async runAndRender(prompt, systemInstruction, runOptions) {
					observedCalls.push({
						prompt,
						systemInstruction,
						conversationId: runOptions?.conversationId,
						correctionAnswer: runOptions?.correctionAnswer,
					});

					return createResponse({
						prompt,
						systemInstruction,
						content: "# Sales dashboard",
					});
				},
				async *runAndRenderStream() {
					yield {
						type: "done" as const,
						response: createResponse({
							prompt: "unused",
							content: "unused",
						}),
					};
				},
			},
		});

		const correctionAnswer = createCorrectionAnswer();
		const envelope = await adapter.run({
			prompt: "Show the sales dashboard",
			systemInstruction: "Use tools before guessing.",
			conversationId: "sales-thread",
			correctionAnswer,
		});

		expect(observedCalls).toEqual([
			{
				prompt: "Show the sales dashboard",
				systemInstruction: "Use tools before guessing.",
				conversationId: "sales-thread",
				correctionAnswer,
			},
		]);
		expect(envelope).toMatchObject({
			conversationId: "sales-thread",
			response: {
				prompt: "Show the sales dashboard",
				content: "# Sales dashboard",
			},
		});
	});

	/**
	 * Covers the stream adapter and reset hook.
	 *
	 * This is useful because the adapter must preserve router stream events, add
	 * the optional conversation envelope, and offer a pluggable reset path without
	 * requiring a specific storage implementation.
	 */
	it("wraps stream events and delegates reset through a modular delete hook", async () => {
		const deletedConversationIds: string[] = [];
		const adapter = createAgenticFlowServerAdapter({
			deleteConversation(conversationId) {
				deletedConversationIds.push(conversationId);
			},
			router: {
				async runAndRender() {
					return createResponse({ prompt: "unused", content: "unused" });
				},
				async *runAndRenderStream(prompt) {
					yield {
						type: "render" as const,
						delta: "Hello ",
						content: "Hello ",
					};
					yield {
						type: "done" as const,
						response: createResponse({
							prompt,
							content: "Hello Paris",
						}),
					};
				},
			},
		});

		const events = [];
		for await (const event of adapter.stream({
			prompt: "Weather in Paris",
			conversationId: "stream-thread",
		})) {
			events.push(event);
		}

		await adapter.reset?.({ conversationId: "  stream-thread  " });

		expect(events).toEqual([
			{
				conversationId: "stream-thread",
				event: {
					type: "render",
					delta: "Hello ",
					content: "Hello ",
				},
			},
			{
				conversationId: "stream-thread",
				event: {
					type: "done",
					response: createResponse({
						prompt: "Weather in Paris",
						content: "Hello Paris",
					}),
				},
			},
		]);
		expect(deletedConversationIds).toEqual(["stream-thread"]);
	});
});

describe("createAgenticFlowEventStream", () => {
	/**
	 * Covers SSE serialization.
	 *
	 * This is useful because runtimes that already own their own routing layer can
	 * reuse the event-stream helper directly and still get the exact wire format
	 * expected by the browser client transport.
	 */
	it("serializes flow events as server-sent events with a done marker", async () => {
		const stream = createAgenticFlowEventStream(
			(async function* () {
				yield {
					conversationId: "stream-thread",
					event: {
						type: "render",
						delta: "Hello ",
						content: "Hello ",
					},
				};
				yield {
					conversationId: "stream-thread",
					event: {
						type: "done",
						response: createResponse({
							prompt: "hello",
							content: "Hello world",
						}),
					},
				};
			})(),
		);

		const text = await new Response(stream).text();

		expect(text).toContain(
			'data: {"conversationId":"stream-thread","event":{"type":"render","delta":"Hello ","content":"Hello "}}\n\n',
		);
		expect(text).toContain("data: [DONE]\n\n");
	});
});

describe("createAgenticFlowWebHandlers", () => {
	/**
	 * Covers the web-standard Request/Response wrapper.
	 *
	 * This is useful because many runtimes now share the Fetch API, and the thin
	 * wrapper should make those environments easy to support without forcing the
	 * package to own a framework-specific server abstraction.
	 */
	it("creates JSON, SSE, and reset handlers over the core adapter", async () => {
		const resetRequests: string[] = [];
		const adapter = createAgenticFlowServerAdapter({
			deleteConversation(conversationId) {
				resetRequests.push(conversationId);
			},
			router: {
				async runAndRender(prompt) {
					return createResponse({
						prompt,
						content: "Buffered hello",
					});
				},
				async *runAndRenderStream(prompt) {
					yield {
						type: "render" as const,
						delta: "Hello ",
						content: "Hello ",
					};
					yield {
						type: "done" as const,
						response: createResponse({
							prompt,
							content: "Hello world",
						}),
					};
				},
			},
		});
		const handlers = createAgenticFlowWebHandlers({ adapter });

		const runResponse = await handlers.run(
			new Request("https://example.com/run", {
				method: "POST",
				body: JSON.stringify({
					prompt: "hello",
					conversationId: "proxy-thread",
				}),
			}),
		);
		const streamResponse = await handlers.stream(
			new Request("https://example.com/stream", {
				method: "POST",
				body: JSON.stringify({
					prompt: "hello",
					conversationId: "proxy-thread",
				}),
			}),
		);
		const resetResponse = await handlers.reset?.(
			new Request("https://example.com/reset", {
				method: "POST",
				body: JSON.stringify({
					conversationId: "proxy-thread",
				}),
			}),
		);

		expect(runResponse.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await runResponse.json()).toEqual({
			conversationId: "proxy-thread",
			response: createResponse({
				prompt: "hello",
				content: "Buffered hello",
			}),
		});
		expect(streamResponse.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(await streamResponse.text()).toContain("data: [DONE]");
		expect(resetResponse?.status).toBe(204);
		expect(resetRequests).toEqual(["proxy-thread"]);
	});
});

function createResponse(
	input: Partial<AgenticRouterResponse> & {
		prompt: string;
		content: string;
	},
): AgenticRouterResponse {
	return {
		status: input.status ?? "completed",
		model: input.model ?? "server-adapter-test-model",
		format: input.format ?? "markdown",
		prompt: input.prompt,
		systemInstruction: input.systemInstruction,
		content: input.content,
		toolCalls: input.toolCalls ?? [],
		iterations: input.iterations ?? 1,
		pendingCorrection: input.pendingCorrection,
	};
}

function createCorrectionAnswer(): AgenticCorrectionAnswer {
	return {
		pendingCorrection: {
			reason: "validation-required",
			message: "Need name",
			toolCall: {
				toolName: "create_user",
				rationale: "Need user data",
				arguments: { role: "admin" },
			},
			fields: [{ name: "name", message: "Required" }],
			originalPrompt: "Create a new admin user",
			iteration: 1,
		},
		values: { name: "Alice Martin" },
	};
}
