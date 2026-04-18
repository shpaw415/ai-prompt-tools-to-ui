import { describe, expect, it } from "bun:test";
import type { AgenticCorrectionAnswer, AgenticRouterResponse } from "../index";
import {
	createAgenticFlowEventStream,
	createAgenticFlowServerAdapter,
	createAgenticFlowWebHandlers,
} from "../server";

describe("createAgenticFlowServerAdapter", () => {
	it("maps a flow run request directly onto the router", async () => {
		const observedCalls: Array<{
			prompt: string;
			systemInstruction?: string;
			conversationId?: string;
			correctionAnswer?: AgenticCorrectionAnswer;
			frontendTools?: readonly unknown[];
			frontendToolResult?: unknown;
		}> = [];
		const adapter = createAgenticFlowServerAdapter({
			router: {
				async runAndRespond(prompt, systemInstruction, runOptions) {
					observedCalls.push({
						prompt,
						systemInstruction,
						conversationId: runOptions?.conversationId,
						correctionAnswer: runOptions?.correctionAnswer,
						frontendTools: runOptions?.frontendTools,
						frontendToolResult: runOptions?.frontendToolResult,
					});

					return createResponse({
						prompt,
						systemInstruction,
						content: "Sales dashboard summary",
					});
				},
				async *runAndRespondStream() {
					yield {
						type: "done" as const,
						response: createResponse({ prompt: "unused", content: "unused" }),
					};
				},
			},
		});

		const correctionAnswer = createCorrectionAnswer();
		const frontendTools = [
			{
				name: "format_currency",
				description: "Format currency on frontend.",
				schema: {
					type: "object",
					properties: {
						amount: { type: "number" },
					},
					required: ["amount"],
				},
			},
		];
		const frontendToolResult = {
			pendingFrontendToolCall: {
				toolCall: {
					toolName: "format_currency",
					rationale: "Need frontend locale formatting.",
					arguments: { amount: 10 },
				},
				originalPrompt: "show payroll",
				iteration: 1,
			},
			result: "$10.00",
		};
		const envelope = await adapter.run({
			prompt: "Show the sales dashboard",
			systemInstruction: "Use tools before guessing.",
			conversationId: "sales-thread",
			correctionAnswer,
			frontendTools,
			frontendToolResult,
		});

		expect(observedCalls).toEqual([
			{
				prompt: "Show the sales dashboard",
				systemInstruction: "Use tools before guessing.",
				conversationId: "sales-thread",
				correctionAnswer,
				frontendTools,
				frontendToolResult,
			},
		]);
		expect(envelope).toMatchObject({
			conversationId: "sales-thread",
			response: {
				prompt: "Show the sales dashboard",
				content: "Sales dashboard summary",
			},
		});
	});

	it("wraps response stream events and delegates reset through a modular delete hook", async () => {
		const deletedConversationIds: string[] = [];
		const adapter = createAgenticFlowServerAdapter({
			deleteConversation(conversationId) {
				deletedConversationIds.push(conversationId);
			},
			router: {
				async runAndRespond() {
					return createResponse({ prompt: "unused", content: "unused" });
				},
				async *runAndRespondStream(prompt) {
					yield {
						type: "response" as const,
						delta: "Hello ",
						content: "Hello ",
					};
					yield {
						type: "done" as const,
						response: createResponse({ prompt, content: "Hello Paris" }),
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
					type: "response",
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
	it("serializes response events as server-sent events with a done marker", async () => {
		const stream = createAgenticFlowEventStream(
			(async function* () {
				yield {
					conversationId: "stream-thread",
					event: {
						type: "response",
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
			'data: {"conversationId":"stream-thread","event":{"type":"response","delta":"Hello ","content":"Hello "}}\n\n',
		);
		expect(text).toContain("data: [DONE]\n\n");
	});
});

describe("createAgenticFlowWebHandlers", () => {
	it("creates JSON, SSE, and reset handlers over the core adapter", async () => {
		const resetRequests: string[] = [];
		const adapter = createAgenticFlowServerAdapter({
			deleteConversation(conversationId) {
				resetRequests.push(conversationId);
			},
			router: {
				async runAndRespond(prompt) {
					return createResponse({ prompt, content: "Buffered hello" });
				},
				async *runAndRespondStream(prompt) {
					yield {
						type: "response" as const,
						delta: "Hello ",
						content: "Hello ",
					};
					yield {
						type: "done" as const,
						response: createResponse({ prompt, content: "Hello world" }),
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
				body: JSON.stringify({ conversationId: "proxy-thread" }),
			}),
		);

		expect(await runResponse.json()).toEqual({
			conversationId: "proxy-thread",
			response: createResponse({ prompt: "hello", content: "Buffered hello" }),
		});
		expect(await streamResponse.text()).toContain('"type":"response"');
		expect(resetResponse?.status).toBe(204);
		expect(resetRequests).toEqual(["proxy-thread"]);
	});
});

function createCorrectionAnswer(): AgenticCorrectionAnswer {
	return {
		pendingCorrection: {
			reason: "validation-required",
			message: "Please provide a name.",
			toolCall: {
				toolName: "create_user",
				rationale: "Need a name.",
				arguments: {},
			},
			fields: [{ name: "name", message: "Required" }],
			originalPrompt: "Create a user",
			iteration: 1,
		},
		values: { name: "Alice" },
	};
}

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
