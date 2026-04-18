import type {
	AgenticFlowRequest,
	AgenticFlowResetRequest,
	AgenticFlowRunResponseEnvelope,
	AgenticFlowStreamEventEnvelope,
} from "../client";
import type {
	AgenticConversationHistoryProvider,
	AgenticRouter,
} from "../index";

type Awaitable<T> = T | Promise<T>;

export type {
	AgenticFlowRequest,
	AgenticFlowResetRequest,
	AgenticFlowRunResponseEnvelope,
	AgenticFlowStreamEventEnvelope,
} from "../client";

export interface AgenticFlowServerAdapterContext {
	signal?: AbortSignal;
}

export interface AgenticFlowServerAdapter {
	run(
		request: AgenticFlowRequest,
		context?: AgenticFlowServerAdapterContext,
	): Promise<AgenticFlowRunResponseEnvelope>;
	stream(
		request: AgenticFlowRequest,
		context?: AgenticFlowServerAdapterContext,
	): AsyncIterable<AgenticFlowStreamEventEnvelope>;
	reset?: (
		request: AgenticFlowResetRequest,
		context?: AgenticFlowServerAdapterContext,
	) => Promise<void>;
}

export interface AgenticFlowServerAdapterOptions {
	router: Pick<AgenticRouter, "runAndRespond" | "runAndRespondStream">;
	historyProvider?: Pick<AgenticConversationHistoryProvider, "delete">;
	deleteConversation?: (
		conversationId: string,
		context?: AgenticFlowServerAdapterContext,
	) => Awaitable<void>;
	includeConversationIdInEnvelope?: boolean;
}

export interface AgenticFlowWebHandlers {
	run(request: Request): Promise<Response>;
	stream(request: Request): Promise<Response>;
	reset?: (request: Request) => Promise<Response>;
}

export interface AgenticFlowWebHandlerOptions {
	adapter: AgenticFlowServerAdapter;
	jsonHeaders?: Record<string, string>;
	streamHeaders?: Record<string, string>;
	resetStatus?: number;
	onError?: (error: unknown, request: Request) => Awaitable<Response>;
}

export interface AgenticFlowEventStreamOptions {
	includeDoneMarker?: boolean;
}

export function createAgenticFlowServerAdapter(
	options: AgenticFlowServerAdapterOptions,
): AgenticFlowServerAdapter {
	const includeConversationId = options.includeConversationIdInEnvelope ?? true;
	const deleteConversation =
		options.deleteConversation ??
		(options.historyProvider?.delete
			? (conversationId: string) =>
					options.historyProvider?.delete?.(conversationId)
			: undefined);

	const adapter: AgenticFlowServerAdapter = {
		async run(request) {
			const response = await options.router.runAndRespond(
				request.prompt,
				request.systemInstruction,
				{
					conversationId: request.conversationId,
					correctionAnswer: request.correctionAnswer,
				},
			);

			return {
				conversationId: includeConversationId
					? request.conversationId
					: undefined,
				response,
			};
		},
		async *stream(request) {
			for await (const event of options.router.runAndRespondStream(
				request.prompt,
				request.systemInstruction,
				{
					conversationId: request.conversationId,
					correctionAnswer: request.correctionAnswer,
				},
			)) {
				yield {
					conversationId: includeConversationId
						? request.conversationId
						: undefined,
					event,
				};
			}
		},
	};

	if (deleteConversation) {
		adapter.reset = async (request, context) => {
			const conversationId = normalizeConversationId(request.conversationId);
			await deleteConversation(conversationId, context);
		};
	}

	return adapter;
}

export function createAgenticFlowWebHandlers(
	options: AgenticFlowWebHandlerOptions,
): AgenticFlowWebHandlers {
	const handlers: AgenticFlowWebHandlers = {
		async run(request) {
			try {
				const payload = (await request.json()) as AgenticFlowRequest;
				const response = await options.adapter.run(payload, {
					signal: request.signal,
				});

				return createJsonResponse(response, {
					status: 200,
					headers: options.jsonHeaders,
				});
			} catch (error) {
				return handleWebHandlerError(options, error, request);
			}
		},
		async stream(request) {
			try {
				const payload = (await request.json()) as AgenticFlowRequest;
				const stream = options.adapter.stream(payload, {
					signal: request.signal,
				});

				return new Response(createAgenticFlowEventStream(stream), {
					status: 200,
					headers: mergeHeaders(
						{
							"cache-control": "no-cache, no-transform",
							connection: "keep-alive",
							"content-type": "text/event-stream; charset=utf-8",
						},
						options.streamHeaders,
					),
				});
			} catch (error) {
				return handleWebHandlerError(options, error, request);
			}
		},
	};

	if (options.adapter.reset) {
		handlers.reset = async (request) => {
			try {
				const payload = (await request.json()) as AgenticFlowResetRequest;
				await options.adapter.reset?.(payload, {
					signal: request.signal,
				});

				return new Response(null, {
					status: options.resetStatus ?? 204,
				});
			} catch (error) {
				return handleWebHandlerError(options, error, request);
			}
		};
	}

	return handlers;
}

export function createAgenticFlowEventStream(
	events: AsyncIterable<AgenticFlowStreamEventEnvelope>,
	options: AgenticFlowEventStreamOptions = {},
): ReadableStream<Uint8Array> {
	const includeDoneMarker = options.includeDoneMarker ?? true;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();

			try {
				for await (const event of events) {
					controller.enqueue(encoder.encode(serializeSSEData(event)));
				}

				if (includeDoneMarker) {
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				}

				controller.close();
			} catch (error) {
				controller.error(toError(error));
			}
		},
	});
}

export function createJsonResponse(
	payload: unknown,
	init: {
		status?: number;
		headers?: Record<string, string>;
	} = {},
): Response {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: mergeHeaders(
			{
				"content-type": "application/json; charset=utf-8",
			},
			init.headers,
		),
	});
}

function serializeSSEData(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function normalizeConversationId(conversationId: string): string {
	const trimmed = conversationId.trim();

	if (!trimmed) {
		throw new Error("Conversation id must be a non-empty string.");
	}

	return trimmed;
}

async function handleWebHandlerError(
	options: AgenticFlowWebHandlerOptions,
	error: unknown,
	request: Request,
): Promise<Response> {
	if (options.onError) {
		return await options.onError(error, request);
	}

	throw error;
}

function mergeHeaders(
	defaults: Record<string, string>,
	overrides?: Record<string, string>,
): Headers {
	const headers = new Headers(defaults);

	for (const [key, value] of Object.entries(overrides ?? {})) {
		headers.set(key, value);
	}

	return headers;
}

function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(
		typeof error === "string" ? error : "Unknown server adapter error.",
	);
}
