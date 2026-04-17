import type { AgenticLLMProvider } from "../index";
import {
	buildNativePlanPrompt,
	buildRenderStreamPrompt,
	buildToolJsonSchema,
	type HttpAgenticProviderClient,
	type HttpAgenticProviderOptions,
	iterateSSEMessages,
	normalizeToolArguments,
	normalizePlanResponse,
	normalizeRenderResponse,
	openEventStream,
	parseJsonText,
	postJson,
	toProviderPrompt,
} from "./shared";

interface OpenAIChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | Array<{ type?: string; text?: string }> | null;
			tool_calls?: Array<{
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
}

interface OpenAIChatCompletionStreamResponse {
	choices?: Array<{
		delta?: {
			content?: string | Array<{ type?: string; text?: string }> | null;
		};
	}>;
}

export interface OpenAIProviderOptions<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
> extends HttpAgenticProviderOptions<Metadata> {
	organization?: string;
	project?: string;
}

/**
 * Creates an OpenAI-compatible provider for ChatGPT models.
 */
export function createOpenAIProvider<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
>(
	options: OpenAIProviderOptions<Metadata>,
): AgenticLLMProvider<
	Metadata & {
		vendor: "openai";
		organization?: string;
		project?: string;
	},
	HttpAgenticProviderClient
> {
	const fetchImplementation = options.fetchImplementation ?? fetch;
	const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";

	return {
		name: options.name ?? "openai",
		model: options.model,
		apiKey: options.apiKey,
		baseUrl,
		client: { fetchImplementation },
		metadata: {
			vendor: "openai",
			organization: options.organization,
			project: options.project,
			...(options.metadata ?? {}),
		} as Metadata & {
			vendor: "openai";
			organization?: string;
			project?: string;
		},
		request: async (request) => {
			if (request.phase === "plan") {
				const response = await postJson<OpenAIChatCompletionResponse>(
					`${baseUrl}/chat/completions`,
					{
						fetchImplementation,
						requestInit: options.requestInit,
						headers: {
							authorization: `Bearer ${options.apiKey}`,
							...(options.organization
								? { "OpenAI-Organization": options.organization }
								: {}),
							...(options.project ? { "OpenAI-Project": options.project } : {}),
							...options.headers,
						},
						body: {
							model: options.model,
							temperature: 0,
							tool_choice: "auto",
							parallel_tool_calls: request.maxToolCalls > 1,
							tools: request.tools.map((tool) => {
								return {
									type: "function",
									function: {
										name: tool.name,
										description: tool.description,
										parameters: buildToolJsonSchema(tool.schema),
									},
								};
							}),
							messages: [
								{
									role: "system",
									content:
										"You are a planning engine. Use native tool calls when needed. If no tool is needed, do not emit any tool call.",
								},
								{
									role: "user",
									content: buildNativePlanPrompt(request),
								},
							],
						},
					},
				);

				return normalizePlanResponse({
					toolCalls: (response.choices?.[0]?.message?.tool_calls ?? []).map(
						(toolCall) => {
							return {
								toolName: toolCall.function?.name,
								rationale: "Native tool call emitted by OpenAI.",
								arguments: normalizeToolArguments(
									toolCall.function?.arguments,
									`OpenAI tool call ${toolCall.function?.name ?? "unknown"}`,
								),
							};
						},
					),
				});
			}

			const response = await postJson<OpenAIChatCompletionResponse>(
				`${baseUrl}/chat/completions`,
				{
					fetchImplementation,
					requestInit: options.requestInit,
					headers: {
						authorization: `Bearer ${options.apiKey}`,
						...(options.organization
							? { "OpenAI-Organization": options.organization }
							: {}),
						...(options.project ? { "OpenAI-Project": options.project } : {}),
						...options.headers,
					},
					body: {
						model: options.model,
						temperature: 0,
						response_format: { type: "json_object" },
						messages: [
							{
								role: "system",
								content:
									"You are a structured JSON API for an agentic router. Return JSON only.",
							},
							{
								role: "user",
								content: toProviderPrompt(request),
							},
						],
					},
				},
			);

			const text = extractOpenAIText(response);
			const parsed = parseJsonText<Record<string, unknown>>(
				text,
				`OpenAI ${request.phase}`,
			);

			return normalizeRenderResponse(parsed);
		},
		stream: async function* (request) {
			const eventStream = await openEventStream(`${baseUrl}/chat/completions`, {
				fetchImplementation,
				requestInit: options.requestInit,
				headers: {
					authorization: `Bearer ${options.apiKey}`,
					...(options.organization
						? { "OpenAI-Organization": options.organization }
						: {}),
					...(options.project ? { "OpenAI-Project": options.project } : {}),
					...options.headers,
				},
				body: {
					model: options.model,
					temperature: 0,
					stream: true,
					messages: [
						{
							role: "system",
							content:
								"You are a streaming render engine for an agentic router. Return only the final rendered output.",
						},
						{
							role: "user",
							content: buildRenderStreamPrompt(request),
						},
					],
				},
			});

			let content = "";

			for await (const message of iterateSSEMessages(eventStream)) {
				const payload = parseJsonText<OpenAIChatCompletionStreamResponse>(
					message,
					"OpenAI stream chunk",
				);
				const delta = extractOpenAIDelta(payload);

				if (!delta) {
					continue;
				}

				content += delta;
				yield {
					phase: "render",
					delta,
					content,
				};
			}
		},
	};
}

/**
 * Alias for consumers who prefer the ChatGPT brand over OpenAI naming.
 */
export const createChatGPTProvider = createOpenAIProvider;

function extractOpenAIText(response: OpenAIChatCompletionResponse): string {
	const content = response.choices?.[0]?.message?.content;

	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		const text = content
			.map((part) => {
				return typeof part.text === "string" ? part.text : "";
			})
			.join("\n")
			.trim();

		if (text) {
			return text;
		}
	}

	throw new Error("OpenAI provider did not return a textual response.");
}

function extractOpenAIDelta(
	response: OpenAIChatCompletionStreamResponse,
): string {
	const content = response.choices?.[0]?.delta?.content;

	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.map((part) => {
				return typeof part.text === "string" ? part.text : "";
			})
			.join("");
	}

	return "";
}
