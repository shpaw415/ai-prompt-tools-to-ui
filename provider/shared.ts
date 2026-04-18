import { z, type ZodTypeAny } from "zod";
import type {
	AgenticLLMResponseStreamChunk,
	AgenticLLMPlanRequest,
	AgenticLLMPlanResponse,
	AgenticLLMProviderRequest,
	AgenticLLMResponseRequest,
	AgenticLLMResponseResponse,
	AgenticLLMToolDescriptor,
	AgenticToolCallPlan,
} from "../index";

export interface HttpAgenticProviderOptions<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
> {
	apiKey: string;
	model: string;
	name?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	metadata?: Metadata;
	fetchImplementation?: typeof fetch;
	requestInit?: Omit<RequestInit, "body" | "headers" | "method">;
}

export interface HttpAgenticProviderClient {
	fetchImplementation: typeof fetch;
}

export interface HttpStreamOpenOptions {
	fetchImplementation?: typeof fetch;
	headers?: Record<string, string>;
	body: unknown;
	requestInit?: Omit<RequestInit, "body" | "headers" | "method">;
}

export interface AgenticJsonSchema {
	type?: string;
	description?: string;
	properties?: Record<string, AgenticJsonSchema>;
	items?: AgenticJsonSchema;
	required?: string[];
	enum?: string[];
	additionalProperties?: boolean;
}

export function buildPlanPrompt(request: AgenticLLMPlanRequest): string {
	return [
		"You are the planning engine for an agentic router.",
		"Return JSON only.",
		"Do not invent missing required tool arguments.",
		"For mutation tools (create/add/update/remove/delete/adjust), never guess required values.",
		"If a tool is clearly needed but required fields are missing or ambiguous, select the tool anyway and omit the unknown fields so the router can request clarification.",
		`Maximum tool calls in this step: ${request.maxToolCalls}`,
		request.systemInstruction
			? `System instruction: ${request.systemInstruction}`
			: "System instruction: none",
		formatConversationHistory(request.conversationHistory),
		`Available tools: ${JSON.stringify(describeTools(request.tools), null, 2)}`,
		`Existing tool results: ${JSON.stringify(request.toolResults, null, 2)}`,
		"Return this exact JSON shape:",
		'{"toolCalls":[{"toolName":"string","rationale":"string","arguments":{}}]}',
		'If no tool is required, return {"toolCalls":[]}.',
		`User prompt: ${request.prompt}`,
	].join("\n\n");
}

export function buildNativePlanPrompt(request: AgenticLLMPlanRequest): string {
	return [
		"You are the planning engine for an agentic router.",
		"Use native tool calls when additional backend data is required.",
		"Planning is not the render phase. Do not answer with HTML, prose, or a client-side form.",
		"If the current tool results are already sufficient, do not call any tool.",
		"Do not invent missing required tool arguments.",
		"For mutation tools (create/add/update/remove/delete/adjust), never guess required values.",
		"If a tool is clearly needed but required fields are missing or ambiguous, emit the tool call with only the known arguments so the router can ask the user for clarification.",
		"Do not ask the user follow-up questions directly and do not replace a missing-argument tool call with a hand-written form. The router handles clarification after validation.",
		"If the user wants to create, update, remove, or otherwise mutate backend data, emit the relevant tool call even when some required arguments are still missing.",
		`Maximum tool calls in this step: ${request.maxToolCalls}`,
		request.systemInstruction
			? `System instruction: ${request.systemInstruction}`
			: "System instruction: none",
		formatConversationHistory(request.conversationHistory),
		`Existing tool results: ${JSON.stringify(request.toolResults, null, 2)}`,
		`User prompt: ${request.prompt}`,
	].join("\n\n");
}

export function buildResponsePrompt(
	request: AgenticLLMResponseRequest,
): string {
	return [
		"You are the final response engine for an agentic router.",
		"Return JSON only.",
		"Summarize only what the tool results prove. Do not invent unseen data.",
		"Describe actions taken and the most relevant retrieved data in plain text.",
		request.systemInstruction
			? `System instruction: ${request.systemInstruction}`
			: "System instruction: none",
		formatConversationHistory(request.conversationHistory),
		`Executed tool results: ${JSON.stringify(request.toolResults, null, 2)}`,
		`Available tools: ${JSON.stringify(describeTools(request.tools), null, 2)}`,
		`User prompt: ${request.prompt}`,
		"Return this exact JSON shape:",
		'{"content":"renderable string"}',
	].join("\n\n");
}

export function buildResponseStreamPrompt(
	request: AgenticLLMResponseRequest,
): string {
	return [
		"You are the streaming final response engine for an agentic router.",
		"Return only the final plain-text summary.",
		"Keep the summary grounded in tool results and do not invent unseen data.",
		"Do not wrap the response in JSON.",
		"Do not add code fences unless the requested output itself requires them.",
		request.systemInstruction
			? `System instruction: ${request.systemInstruction}`
			: "System instruction: none",
		formatConversationHistory(request.conversationHistory),
		`Executed tool results: ${JSON.stringify(request.toolResults, null, 2)}`,
		`Available tools: ${JSON.stringify(describeTools(request.tools), null, 2)}`,
		`User prompt: ${request.prompt}`,
	].join("\n\n");
}

export async function postJson<T>(
	url: string,
	options: {
		fetchImplementation?: typeof fetch;
		headers?: Record<string, string>;
		body: unknown;
		requestInit?: Omit<RequestInit, "body" | "headers" | "method">;
	},
): Promise<T> {
	const response = await (options.fetchImplementation ?? fetch)(url, {
		method: "POST",
		...options.requestInit,
		headers: {
			"content-type": "application/json",
			...options.headers,
		},
		body: JSON.stringify(options.body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Provider request failed with ${response.status} ${response.statusText}: ${errorText}`,
		);
	}

	return (await response.json()) as T;
}

export async function openEventStream(
	url: string,
	options: HttpStreamOpenOptions,
): Promise<ReadableStream<Uint8Array>> {
	const response = await (options.fetchImplementation ?? fetch)(url, {
		method: "POST",
		...options.requestInit,
		headers: {
			"content-type": "application/json",
			accept: "text/event-stream",
			...options.headers,
		},
		body: JSON.stringify(options.body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Provider stream failed with ${response.status} ${response.statusText}: ${errorText}`,
		);
	}

	if (!response.body) {
		throw new Error("Provider stream did not return a readable body.");
	}

	return response.body;
}

export async function* iterateSSEMessages(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
		buffer = buffer.replace(/\r\n/g, "\n");

		let boundaryIndex = buffer.indexOf("\n\n");

		while (boundaryIndex !== -1) {
			const eventBlock = buffer.slice(0, boundaryIndex);
			buffer = buffer.slice(boundaryIndex + 2);
			const data = eventBlock
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n")
				.trim();

			if (data) {
				if (data === "[DONE]") {
					return;
				}

				yield data;
			}

			boundaryIndex = buffer.indexOf("\n\n");
		}

		if (done) {
			break;
		}
	}

	const tail = buffer.trim();
	if (tail) {
		const data = tail
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();

		if (data && data !== "[DONE]") {
			yield data;
		}
	}
}

export async function collectStreamChunks(
	chunks: AsyncIterable<AgenticLLMResponseStreamChunk>,
): Promise<AgenticLLMResponseStreamChunk[]> {
	const collected: AgenticLLMResponseStreamChunk[] = [];

	for await (const chunk of chunks) {
		collected.push(chunk);
	}

	return collected;
}

export function parseJsonText<T>(rawText: string, label: string): T {
	const normalized = stripCodeFence(rawText).trim();

	try {
		return JSON.parse(normalized) as T;
	} catch {
		const extracted = normalized.match(/\{[\s\S]*\}$/)?.[0];

		if (!extracted) {
			throw new Error(`Unable to parse ${label} JSON response.`);
		}

		return JSON.parse(extracted) as T;
	}
}

export function normalizePlanResponse(
	payload: unknown,
): AgenticLLMPlanResponse {
	const toolCalls = Array.isArray(
		(payload as { toolCalls?: unknown }).toolCalls,
	)
		? ((payload as { toolCalls: unknown[] }).toolCalls
				.map(normalizeToolCall)
				.filter(Boolean) as AgenticToolCallPlan[])
		: [];

	return {
		phase: "plan",
		toolCalls,
	};
}

export function buildToolJsonSchema(schema: unknown): AgenticJsonSchema {
	if (isAgenticJsonSchema(schema)) {
		return schema;
	}

	if (!(schema instanceof z.ZodType)) {
		return {};
	}

	const baseSchema = unwrapSchema(schema);

	if (baseSchema instanceof z.ZodString) {
		return { type: "string" };
	}

	if (baseSchema instanceof z.ZodNumber) {
		return { type: isIntegerSchema(baseSchema) ? "integer" : "number" };
	}

	if (baseSchema instanceof z.ZodBoolean) {
		return { type: "boolean" };
	}

	if (baseSchema instanceof z.ZodArray) {
		return {
			type: "array",
			items: buildToolJsonSchema(
				(baseSchema as unknown as { element?: ZodTypeAny }).element ??
					z.unknown(),
			),
		};
	}

	if (baseSchema instanceof z.ZodObject) {
		const properties = Object.fromEntries(
			Object.entries(baseSchema.shape).map(([key, value]) => {
				return [key, buildToolJsonSchema(value)];
			}),
		);
		const required = Object.entries(baseSchema.shape)
			.filter(([, value]) => !isOptionalSchema(value))
			.map(([key]) => key);

		return {
			type: "object",
			properties,
			required,
			additionalProperties: false,
		};
	}

	const enumValues = extractEnumValues(baseSchema);
	if (enumValues.length > 0) {
		return {
			type: "string",
			enum: enumValues,
		};
	}

	return {};
}

export function toGeminiToolSchema(
	schema: AgenticJsonSchema,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	if (schema.type) {
		result.type = schema.type.toUpperCase();
	}

	if (schema.description) {
		result.description = schema.description;
	}

	if (schema.enum) {
		result.enum = schema.enum;
	}

	if (schema.items) {
		result.items = toGeminiToolSchema(schema.items);
	}

	if (schema.properties) {
		result.properties = Object.fromEntries(
			Object.entries(schema.properties).map(([key, value]) => {
				return [key, toGeminiToolSchema(value)];
			}),
		);
	}

	if (schema.required?.length) {
		result.required = schema.required;
	}

	return result;
}

export function normalizeToolArguments(
	value: unknown,
	label: string,
): Record<string, unknown> {
	if (!value) {
		return {};
	}

	if (typeof value === "string") {
		return parseJsonText<Record<string, unknown>>(value, label);
	}

	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	throw new Error(`${label} must be a JSON object.`);
}

export function normalizeResponsePayload(
	payload: unknown,
): AgenticLLMResponseResponse {
	const content = (payload as { content?: unknown }).content;

	if (typeof content !== "string") {
		throw new Error(
			"Provider response payload must contain a string content field.",
		);
	}

	return {
		phase: "respond",
		content,
	};
}

export function toProviderPrompt(request: AgenticLLMProviderRequest): string {
	return request.phase === "plan"
		? buildPlanPrompt(request)
		: buildResponsePrompt(request);
}

export function stripCodeFence(value: string): string {
	return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function formatConversationHistory(
	history:
		| AgenticLLMPlanRequest["conversationHistory"]
		| AgenticLLMResponseRequest["conversationHistory"],
): string {
	if (!history?.length) {
		return "";
	}

	return [
		"Recent conversation history:",
		...history.map((message) => {
			return `${message.role.toUpperCase()}: ${message.content}`;
		}),
	].join("\n");
}

function normalizeToolCall(payload: unknown): AgenticToolCallPlan | null {
	const candidate = payload as {
		toolName?: unknown;
		rationale?: unknown;
		arguments?: unknown;
	};

	if (typeof candidate.toolName !== "string") {
		return null;
	}

	return {
		toolName: candidate.toolName,
		rationale:
			typeof candidate.rationale === "string"
				? candidate.rationale
				: "No rationale provided.",
		arguments:
			candidate.arguments && typeof candidate.arguments === "object"
				? (candidate.arguments as Record<string, unknown>)
				: {},
	};
}

function describeTools(tools: readonly AgenticLLMToolDescriptor[]): unknown[] {
	return tools.map((tool) => {
		return {
			name: tool.name,
			description: tool.description,
			schema: describeSchema(tool.schema),
		};
	});
}

function describeSchema(schema: unknown): unknown {
	const jsonSchema = buildToolJsonSchema(schema);

	if (jsonSchema.enum?.length) {
		return { type: "enum", values: jsonSchema.enum };
	}

	if (jsonSchema.type === "object") {
		return {
			type: "object",
			properties: jsonSchema.properties,
		};
	}

	if (jsonSchema.type === "array") {
		return {
			type: "array",
			items: jsonSchema.items,
		};
	}

	return { type: jsonSchema.type ?? "unknown" };
}

function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
	const candidate = schema as ZodTypeAny & {
		unwrap?: () => ZodTypeAny;
		removeDefault?: () => ZodTypeAny;
	};

	if (typeof candidate.removeDefault === "function") {
		return unwrapSchema(candidate.removeDefault());
	}

	if (typeof candidate.unwrap === "function") {
		return unwrapSchema(candidate.unwrap());
	}

	return schema;
}

function isAgenticJsonSchema(schema: unknown): schema is AgenticJsonSchema {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return false;
	}

	const candidate = schema as AgenticJsonSchema;

	if (candidate.type && typeof candidate.type !== "string") {
		return false;
	}

	if (candidate.description && typeof candidate.description !== "string") {
		return false;
	}

	if (
		candidate.required &&
		(!Array.isArray(candidate.required) ||
			candidate.required.some((entry) => typeof entry !== "string"))
	) {
		return false;
	}

	if (
		candidate.enum &&
		(!Array.isArray(candidate.enum) ||
			candidate.enum.some((entry) => typeof entry !== "string"))
	) {
		return false;
	}

	if (
		candidate.additionalProperties !== undefined &&
		typeof candidate.additionalProperties !== "boolean"
	) {
		return false;
	}

	if (candidate.properties && typeof candidate.properties !== "object") {
		return false;
	}

	return true;
}

function isOptionalSchema(schema: ZodTypeAny): boolean {
	return schema.safeParse(undefined).success;
}

function isIntegerSchema(schema: ZodTypeAny): boolean {
	const candidate = schema as ZodTypeAny & {
		def?: { type?: string; checks?: Array<{ format?: string; kind?: string }> };
		_def?: { typeName?: string; checks?: Array<{ kind?: string }> };
	};
	const checks = [
		...(candidate.def?.checks ?? []),
		...(candidate._def?.checks ?? []),
	];

	return checks.some((check) => {
		return (
			check.kind === "int" ||
			check.format === "safeint" ||
			check.format === "int"
		);
	});
}

function extractEnumValues(schema: ZodTypeAny): string[] {
	const candidate = schema as ZodTypeAny & {
		options?: readonly string[];
		enum?: Record<string, unknown>;
	};

	if (Array.isArray(candidate.options)) {
		return candidate.options.filter(
			(option): option is string => typeof option === "string",
		);
	}

	if (candidate.enum && typeof candidate.enum === "object") {
		return Object.values(candidate.enum).filter(
			(option): option is string => typeof option === "string",
		);
	}

	return [];
}
