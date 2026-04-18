import type { AgenticLLMProvider } from "../index";
import {
	buildNativePlanPrompt,
	buildResponseStreamPrompt,
	buildToolJsonSchema,
	type HttpAgenticProviderClient,
	type HttpAgenticProviderOptions,
	iterateSSEMessages,
	normalizeToolArguments,
	normalizePlanResponse,
	normalizeResponsePayload,
	openEventStream,
	parseJsonText,
	postJson,
	toProviderPrompt,
} from "./shared";

interface AnthropicMessagesResponse {
	content?: Array<{
		type?: string;
		text?: string;
		name?: string;
		input?: unknown;
	}>;
}

interface AnthropicStreamEvent {
	type?: string;
	delta?: { text?: string };
}

export interface AnthropicProviderOptions<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
> extends HttpAgenticProviderOptions<Metadata> {
	/** @deprecated Use anthropicVersion instead. */
	antrophicVersion?: string;
	anthropicVersion?: string;
	maxTokens?: number;
}

/**
 * Creates an Anthropic Claude provider using the Messages REST API.
 */
export function createAnthropicProvider<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
>(
	options: AnthropicProviderOptions<Metadata>,
): AgenticLLMProvider<
	Metadata & {
		vendor: "anthropic";
		anthropicVersion: string;
		maxTokens: number;
	},
	HttpAgenticProviderClient
> {
	const fetchImplementation = options.fetchImplementation ?? fetch;
	const baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
	const anthropicVersion =
		options.anthropicVersion ?? options.antrophicVersion ?? "2023-06-01";
	const maxTokens = options.maxTokens ?? 1024;

	return {
		name: options.name ?? "anthropic-claude",
		model: options.model,
		apiKey: options.apiKey,
		baseUrl,
		client: { fetchImplementation },
		metadata: {
			vendor: "anthropic",
			anthropicVersion,
			maxTokens,
			...(options.metadata ?? {}),
		} as Metadata & {
			vendor: "anthropic";
			anthropicVersion: string;
			maxTokens: number;
		},
		request: async (request) => {
			if (request.phase === "plan") {
				const response = await postJson<AnthropicMessagesResponse>(
					`${baseUrl}/messages`,
					{
						fetchImplementation,
						requestInit: options.requestInit,
						headers: {
							"x-api-key": options.apiKey,
							"anthropic-version": anthropicVersion,
							...options.headers,
						},
						body: {
							model: options.model,
							max_tokens: maxTokens,
							temperature: 0,
							system:
								"You are a planning engine. Use native tool calls when needed. If no tool is needed, do not emit any tool_use block.",
							tools: request.tools.map((tool) => {
								return {
									name: tool.name,
									description: tool.description,
									input_schema: buildToolJsonSchema(tool.schema),
								};
							}),
							messages: [
								{
									role: "user",
									content: buildNativePlanPrompt(request),
								},
							],
						},
					},
				);

				return normalizePlanResponse({
					toolCalls: (response.content ?? [])
						.filter((part) => {
							return part.type === "tool_use" && typeof part.name === "string";
						})
						.map((part) => {
							return {
								toolName: part.name ?? "unknown_tool",
								rationale: "Native tool call emitted by Anthropic.",
								arguments: normalizeToolArguments(
									part.input,
									`Anthropic tool call ${part.name ?? "unknown"}`,
								),
							};
						}),
				});
			}

			const response = await postJson<AnthropicMessagesResponse>(
				`${baseUrl}/messages`,
				{
					fetchImplementation,
					requestInit: options.requestInit,
					headers: {
						"x-api-key": options.apiKey,
						"anthropic-version": anthropicVersion,
						...options.headers,
					},
					body: {
						model: options.model,
						max_tokens: maxTokens,
						temperature: 0,
						system:
							"You are a structured JSON API for an agentic router. Return JSON only.",
						messages: [
							{
								role: "user",
								content: toProviderPrompt(request),
							},
						],
					},
				},
			);

			const text = extractAnthropicText(response);
			const parsed = parseJsonText<Record<string, unknown>>(
				text,
				`Anthropic ${request.phase}`,
			);

			return normalizeResponsePayload(parsed);
		},
		stream: async function* (request) {
			const eventStream = await openEventStream(`${baseUrl}/messages`, {
				fetchImplementation,
				requestInit: options.requestInit,
				headers: {
					"x-api-key": options.apiKey,
					"anthropic-version": anthropicVersion,
					...options.headers,
				},
				body: {
					model: options.model,
					max_tokens: maxTokens,
					temperature: 0,
					stream: true,
					system:
						"You are a streaming final response engine for an agentic router. Return only the final plain-text summary.",
					messages: [
						{
							role: "user",
							content: buildResponseStreamPrompt(request),
						},
					],
				},
			});

			let content = "";

			for await (const message of iterateSSEMessages(eventStream)) {
				const payload = parseJsonText<AnthropicStreamEvent>(
					message,
					"Anthropic stream chunk",
				);
				const delta =
					payload.type === "content_block_delta"
						? (payload.delta?.text ?? "")
						: "";

				if (!delta) {
					continue;
				}

				content += delta;
				yield {
					phase: "respond",
					delta,
					content,
				};
			}
		},
	};
}

/**
 * Alias for consumers who prefer Claude naming.
 */
export const createClaudeProvider = createAnthropicProvider;

function extractAnthropicText(response: AnthropicMessagesResponse): string {
	const text = (response.content ?? [])
		.map((part) => {
			return typeof part.text === "string" ? part.text : "";
		})
		.join("\n")
		.trim();

	if (!text) {
		throw new Error("Anthropic provider did not return a textual response.");
	}

	return text;
}
