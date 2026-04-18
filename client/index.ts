import { iterateSSEMessages } from "../provider/shared";
import type {
	AgenticCorrectionAnswer,
	AgenticPendingCorrection,
	AgenticRouterResponse,
	AgenticRouterStreamEvent,
	AgenticToolCallPlan,
	AgenticToolExecutionResult,
} from "../index";

export type {
	AgenticCorrectionAnswer,
	AgenticPendingCorrection,
	AgenticRouterResponse,
	AgenticRouterStreamEvent,
	AgenticToolCallPlan,
	AgenticToolExecutionResult,
} from "../index";

export type AgenticTransportHeaders =
	| Headers
	| Record<string, string>
	| Array<[string, string]>;

export interface AgenticFlowRequest {
	prompt: string;
	systemInstruction?: string;
	conversationId?: string;
	correctionAnswer?: AgenticCorrectionAnswer;
}

export interface AgenticFlowRunResponseEnvelope {
	conversationId?: string;
	response: AgenticRouterResponse;
}

export interface AgenticFlowStreamEventEnvelope {
	conversationId?: string;
	event: AgenticRouterStreamEvent;
}

export interface AgenticFlowResetRequest {
	conversationId: string;
}

export interface AgenticFlowTransport {
	run(
		request: AgenticFlowRequest,
		options?: { signal?: AbortSignal },
	): Promise<AgenticFlowRunResponseEnvelope>;
	stream?(
		request: AgenticFlowRequest,
		options?: { signal?: AbortSignal },
	): AsyncIterable<AgenticFlowStreamEventEnvelope>;
	reset?(
		request: AgenticFlowResetRequest,
		options?: { signal?: AbortSignal },
	): Promise<void>;
}

export interface FetchAgenticFlowTransportOptions {
	baseUrl: string;
	runPath?: string;
	streamPath?: string;
	resetPath?: string;
	headers?: AgenticTransportHeaders;
	fetchImplementation?: typeof fetch;
	requestInit?: Omit<RequestInit, "body" | "headers" | "method" | "signal">;
}

export type AgenticFlowStatus =
	| "idle"
	| "running"
	| "streaming"
	| "awaiting-input"
	| "completed"
	| "error";

export interface AgenticFlowState {
	status: AgenticFlowStatus;
	conversationId?: string;
	activePrompt?: string;
	systemInstruction?: string;
	content: string;
	plannedToolCalls: AgenticToolCallPlan[];
	toolCalls: AgenticToolExecutionResult[];
	pendingCorrection?: AgenticPendingCorrection;
	lastResponse?: AgenticRouterResponse;
	error?: Error;
}

export interface AgenticFlowClientOptions {
	transport: AgenticFlowTransport;
	conversationId?: string;
	createConversationId?: () => string;
}

export interface AgenticFlowRunOptions {
	conversationId?: string;
	systemInstruction?: string;
	signal?: AbortSignal;
	resetContent?: boolean;
}

interface InternalAgenticFlowRunOptions extends AgenticFlowRunOptions {
	correctionAnswer?: AgenticCorrectionAnswer;
}

export interface AgenticFlowResumeOptions {
	pendingCorrection?: AgenticPendingCorrection;
	values?: Record<string, unknown>;
	confirmed?: boolean;
	prompt?: string;
	conversationId?: string;
	systemInstruction?: string;
	signal?: AbortSignal;
	resetContent?: boolean;
}

const DEFAULT_STATE: AgenticFlowState = {
	status: "idle",
	content: "",
	plannedToolCalls: [],
	toolCalls: [],
};

export class AgenticFlowClient {
	private readonly transport: AgenticFlowTransport;

	private readonly createConversationIdValue: () => string;

	private state: AgenticFlowState;

	private readonly listeners = new Set<(state: AgenticFlowState) => void>();

	constructor(options: AgenticFlowClientOptions) {
		this.transport = options.transport;
		this.createConversationIdValue =
			options.createConversationId ?? createDefaultConversationId;
		this.state = {
			...DEFAULT_STATE,
			conversationId: options.conversationId,
		};
	}

	getState(): AgenticFlowState {
		return cloneState(this.state);
	}

	subscribe(listener: (state: AgenticFlowState) => void): () => void {
		this.listeners.add(listener);
		listener(this.getState());

		return () => {
			this.listeners.delete(listener);
		};
	}

	startConversation(conversationId = this.createConversationIdValue()): string {
		this.updateState({
			conversationId,
			pendingCorrection: undefined,
			error: undefined,
			lastResponse: undefined,
			status: this.state.status === "idle" ? "idle" : this.state.status,
		});

		return conversationId;
	}

	setConversationId(conversationId?: string): void {
		this.updateState({ conversationId });
	}

	clearError(): void {
		if (!this.state.error) {
			return;
		}

		this.updateState({ error: undefined });
	}

	async run(
		prompt: string,
		options: AgenticFlowRunOptions = {},
	): Promise<AgenticRouterResponse> {
		const request = this.createRequest(prompt, options);
		this.beginRequest(request, {
			status: "running",
			resetContent: options.resetContent ?? true,
		});

		try {
			const envelope = normalizeRunResponse(
				await this.transport.run(request, {
					signal: options.signal,
				}),
			);
			const response = envelope.response;

			this.completeResponse(
				response,
				envelope.conversationId ?? request.conversationId,
			);

			return response;
		} catch (error) {
			throw this.failRequest(error, request.conversationId);
		}
	}

	async *stream(
		prompt: string,
		options: AgenticFlowRunOptions = {},
	): AsyncGenerator<AgenticRouterStreamEvent, AgenticRouterResponse, void> {
		if (!this.transport.stream) {
			const response = await this.run(prompt, options);
			yield {
				type: "done",
				response,
			};
			return response;
		}

		const request = this.createRequest(prompt, options);
		this.beginRequest(request, {
			status: "streaming",
			resetContent: options.resetContent ?? true,
		});

		try {
			let finalResponse: AgenticRouterResponse | undefined;

			for await (const item of this.transport.stream(request, {
				signal: options.signal,
			})) {
				const envelope = normalizeStreamEvent(item);
				const conversationId =
					envelope.conversationId ?? request.conversationId;

				this.applyStreamEvent(envelope.event, conversationId, request);
				if (envelope.event.type === "done") {
					finalResponse = envelope.event.response;
				}

				yield envelope.event;
			}

			if (!finalResponse) {
				throw new Error("Stream completed without a final done event.");
			}

			return finalResponse;
		} catch (error) {
			throw this.failRequest(error, request.conversationId);
		}
	}

	async resumeCorrection(
		options: AgenticFlowResumeOptions = {},
	): Promise<AgenticRouterResponse> {
		const pendingCorrection = this.resolvePendingCorrection(
			options.pendingCorrection,
		);
		const prompt =
			options.prompt ??
			createCorrectionPrompt(options.values, options.confirmed) ??
			pendingCorrection.originalPrompt;

		return this.run(prompt, {
			conversationId:
				options.conversationId ?? this.state.conversationId ?? undefined,
			systemInstruction:
				options.systemInstruction ??
				pendingCorrection.originalSystemInstruction,
			signal: options.signal,
			resetContent: options.resetContent,
			...buildCorrectionRunOptions(pendingCorrection, options),
		} satisfies InternalAgenticFlowRunOptions);
	}

	async *resumeCorrectionStream(
		options: AgenticFlowResumeOptions = {},
	): AsyncGenerator<AgenticRouterStreamEvent, AgenticRouterResponse, void> {
		const pendingCorrection = this.resolvePendingCorrection(
			options.pendingCorrection,
		);
		const prompt =
			options.prompt ??
			createCorrectionPrompt(options.values, options.confirmed) ??
			pendingCorrection.originalPrompt;

		for await (const event of this.stream(prompt, {
			conversationId:
				options.conversationId ?? this.state.conversationId ?? undefined,
			systemInstruction:
				options.systemInstruction ??
				pendingCorrection.originalSystemInstruction,
			signal: options.signal,
			resetContent: options.resetContent,
			...buildCorrectionRunOptions(pendingCorrection, options),
		} satisfies InternalAgenticFlowRunOptions)) {
			yield event;
		}

		return this.state.lastResponse as AgenticRouterResponse;
	}

	async reset(
		options: {
			conversationId?: string;
			clearRemote?: boolean;
			signal?: AbortSignal;
		} = {},
	): Promise<void> {
		const conversationId = options.conversationId ?? this.state.conversationId;

		if (
			options.clearRemote !== false &&
			conversationId &&
			this.transport.reset
		) {
			await this.transport.reset(
				{ conversationId },
				{ signal: options.signal },
			);
		}

		this.updateState({
			...DEFAULT_STATE,
			conversationId: options.conversationId,
		});
	}

	private resolvePendingCorrection(
		pendingCorrection?: AgenticPendingCorrection,
	): AgenticPendingCorrection {
		const resolved = pendingCorrection ?? this.state.pendingCorrection;

		if (!resolved) {
			throw new Error(
				"No pending correction is available. Pass one explicitly or resume after a needs-user-input response.",
			);
		}

		return resolved;
	}

	private createRequest(
		prompt: string,
		options: InternalAgenticFlowRunOptions,
	): AgenticFlowRequest {
		const conversationId =
			options.conversationId ??
			this.state.conversationId ??
			this.createConversationIdValue();

		return {
			prompt,
			systemInstruction: options.systemInstruction,
			conversationId,
			correctionAnswer: options.correctionAnswer,
		};
	}

	private beginRequest(
		request: AgenticFlowRequest,
		options: {
			status: Extract<AgenticFlowStatus, "running" | "streaming">;
			resetContent: boolean;
		},
	): void {
		this.updateState({
			status: options.status,
			conversationId: request.conversationId,
			activePrompt: request.prompt,
			systemInstruction: request.systemInstruction,
			content: options.resetContent ? "" : this.state.content,
			plannedToolCalls: [],
			toolCalls: [],
			pendingCorrection: undefined,
			lastResponse: undefined,
			error: undefined,
		});
	}

	private completeResponse(
		response: AgenticRouterResponse,
		conversationId?: string,
	): void {
		this.updateState({
			status:
				response.status === "needs-user-input" ? "awaiting-input" : "completed",
			conversationId,
			content: response.content,
			toolCalls: [...response.toolCalls],
			pendingCorrection: response.pendingCorrection,
			lastResponse: response,
			error: undefined,
		});
	}

	private applyStreamEvent(
		event: AgenticRouterStreamEvent,
		conversationId: string | undefined,
		request: AgenticFlowRequest,
	): void {
		switch (event.type) {
			case "tool-call":
				this.updateState({
					status: "streaming",
					conversationId,
					activePrompt: request.prompt,
					systemInstruction: request.systemInstruction,
					plannedToolCalls: [...this.state.plannedToolCalls, event.toolCall],
				});
				return;
			case "tool-result":
				this.updateState({
					status: "streaming",
					conversationId,
					toolCalls: [...this.state.toolCalls, event.result],
				});
				return;
			case "response":
				this.updateState({
					status: "streaming",
					conversationId,
					content: event.content,
				});
				return;
			case "needs-user-input":
				this.completeResponse(event.response, conversationId);
				return;
			case "done":
				this.completeResponse(event.response, conversationId);
				return;
		}
	}

	private failRequest(error: unknown, conversationId?: string): Error {
		const resolved = toError(error);
		this.updateState({
			status: "error",
			conversationId,
			error: resolved,
		});

		return resolved;
	}

	private updateState(next: Partial<AgenticFlowState>): void {
		this.state = {
			...this.state,
			...next,
		};

		const snapshot = this.getState();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

export function createAgenticFlowClient(
	options: AgenticFlowClientOptions,
): AgenticFlowClient {
	return new AgenticFlowClient(options);
}

export function createFetchAgenticFlowTransport(
	options: FetchAgenticFlowTransportOptions,
): AgenticFlowTransport {
	const fetchImplementation = options.fetchImplementation ?? fetch;
	const runUrl = resolveTransportUrl(options.baseUrl, options.runPath ?? "run");
	const streamUrl = resolveTransportUrl(
		options.baseUrl,
		options.streamPath ?? "stream",
	);
	const resetUrl = resolveTransportUrl(
		options.baseUrl,
		options.resetPath ?? "reset",
	);

	return {
		async run(request, requestOptions) {
			const response = await fetchImplementation(runUrl, {
				method: "POST",
				...options.requestInit,
				headers: mergeHeaders(options.headers, {
					"content-type": "application/json",
				}),
				signal: requestOptions?.signal,
				body: JSON.stringify(request),
			});

			if (!response.ok) {
				throw await createTransportError(response, "run request failed");
			}

			const payload = (await response.json()) as
				| AgenticFlowRunResponseEnvelope
				| AgenticRouterResponse;

			return normalizeRunResponse(payload);
		},
		async *stream(request, requestOptions) {
			const response = await fetchImplementation(streamUrl, {
				method: "POST",
				...options.requestInit,
				headers: mergeHeaders(options.headers, {
					accept: "text/event-stream",
					"content-type": "application/json",
				}),
				signal: requestOptions?.signal,
				body: JSON.stringify(request),
			});

			if (!response.ok) {
				throw await createTransportError(response, "stream request failed");
			}

			if (!response.body) {
				throw new Error("Stream response did not include a readable body.");
			}

			for await (const message of iterateSSEMessages(response.body)) {
				const payload = JSON.parse(message) as
					| AgenticFlowStreamEventEnvelope
					| AgenticRouterStreamEvent;

				yield normalizeStreamEvent(payload);
			}
		},
		async reset(request, requestOptions) {
			const response = await fetchImplementation(resetUrl, {
				method: "POST",
				...options.requestInit,
				headers: mergeHeaders(options.headers, {
					"content-type": "application/json",
				}),
				signal: requestOptions?.signal,
				body: JSON.stringify(request),
			});

			if (!response.ok) {
				throw await createTransportError(response, "reset request failed");
			}
		},
	};
}

function buildCorrectionRunOptions(
	pendingCorrection: AgenticPendingCorrection,
	options: AgenticFlowResumeOptions,
): Pick<
	AgenticFlowRunOptions & { correctionAnswer: AgenticCorrectionAnswer },
	"correctionAnswer"
> {
	return {
		correctionAnswer: {
			pendingCorrection,
			values: options.values,
			confirmed: options.confirmed,
		},
	};
}

function normalizeRunResponse(
	payload: AgenticFlowRunResponseEnvelope | AgenticRouterResponse,
): AgenticFlowRunResponseEnvelope {
	if (isRouterResponse(payload)) {
		return {
			response: payload,
		};
	}

	return payload;
}

function normalizeStreamEvent(
	payload: AgenticFlowStreamEventEnvelope | AgenticRouterStreamEvent,
): AgenticFlowStreamEventEnvelope {
	if ("event" in payload) {
		return payload;
	}

	return { event: payload };
}

function isRouterResponse(value: unknown): value is AgenticRouterResponse {
	return Boolean(
		value &&
			typeof value === "object" &&
			"status" in value &&
			"content" in value &&
			"toolCalls" in value,
	);
}

function cloneState(state: AgenticFlowState): AgenticFlowState {
	return {
		...state,
		plannedToolCalls: [...state.plannedToolCalls],
		toolCalls: [...state.toolCalls],
	};
}

function resolveTransportUrl(baseUrl: string, path: string): string {
	if (isAbsoluteUrl(path)) {
		return path;
	}

	if (!isAbsoluteUrl(baseUrl)) {
		return joinRelativeTransportUrl(baseUrl, path);
	}

	return new URL(path, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function isAbsoluteUrl(value: string): boolean {
	return /^[a-z][a-z\d+\-.]*:\/\//i.test(value);
}

function joinRelativeTransportUrl(baseUrl: string, path: string): string {
	if (path.startsWith("/")) {
		return path;
	}

	const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	return `${normalizedBase}/${path}`;
}

function mergeHeaders(
	existing: AgenticTransportHeaders | undefined,
	overrides: Record<string, string>,
): Headers {
	const headers = new Headers();

	if (existing instanceof Headers) {
		existing.forEach((value, key) => {
			headers.set(key, value);
		});
	} else if (Array.isArray(existing)) {
		for (const [key, value] of existing) {
			headers.set(key, value);
		}
	} else if (existing) {
		for (const [key, value] of Object.entries(existing)) {
			headers.set(key, value);
		}
	}

	for (const [key, value] of Object.entries(overrides)) {
		headers.set(key, value);
	}

	return headers;
}

function createDefaultConversationId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}

	return `agentic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCorrectionPrompt(
	values: Record<string, unknown> | undefined,
	confirmed: boolean | undefined,
): string | undefined {
	if (confirmed && (!values || Object.keys(values).length === 0)) {
		return "Confirmed";
	}

	if (!values || Object.keys(values).length === 0) {
		return undefined;
	}

	const entries = Object.entries(values);
	if (entries.length === 1) {
		return stringifyCorrectionValue(entries[0]?.[1]);
	}

	return JSON.stringify(values);
}

function stringifyCorrectionValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return String(value);
	}

	return JSON.stringify(value);
}

async function createTransportError(
	response: Response,
	message: string,
): Promise<Error> {
	const body = await response.text();
	return new Error(
		`${message}: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
	);
}

function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(
		typeof error === "string" ? error : "Unknown flow client error.",
	);
}
