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

interface GitHubChatCompletionResponse {
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

interface GitHubChatCompletionStreamResponse {
	choices?: Array<{
		delta?: {
			content?: string | Array<{ type?: string; text?: string }> | null;
		};
	}>;
}

export interface GitHubModelsProviderOptions<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
> extends HttpAgenticProviderOptions<Metadata> {
	apiVersion?: string;
	organization?: string;
}

/**
 * Creates a GitHub Models provider backed by the public GitHub inference API.
 *
 * The provider accepts any model identifier available through GitHub Models,
 * such as `openai/gpt-4.1`, `anthropic/claude-sonnet-4`, or other catalog IDs.
 */
export function createGitHubModelsProvider<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
>(
	options: GitHubModelsProviderOptions<Metadata>,
): AgenticLLMProvider<
	Metadata & {
		vendor: "github-models";
		apiVersion: string;
		organization?: string;
	},
	HttpAgenticProviderClient
> {
	const fetchImplementation = options.fetchImplementation ?? fetch;
	const baseUrl = options.baseUrl ?? "https://models.github.ai";
	const apiVersion = options.apiVersion ?? "2026-03-10";
	const endpoint = options.organization
		? `${baseUrl}/orgs/${encodeURIComponent(options.organization)}/inference/chat/completions`
		: `${baseUrl}/inference/chat/completions`;

	const baseHeaders = {
		authorization: `Bearer ${options.apiKey}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": apiVersion,
		...options.headers,
	};

	return {
		name: options.name ?? "github-models",
		model: options.model,
		apiKey: options.apiKey,
		baseUrl,
		client: { fetchImplementation },
		metadata: {
			vendor: "github-models",
			apiVersion,
			organization: options.organization,
			...(options.metadata ?? {}),
		} as Metadata & {
			vendor: "github-models";
			apiVersion: string;
			organization?: string;
		},
		request: async (request) => {
			if (request.phase === "plan") {
				const response = await postJson<GitHubChatCompletionResponse>(
					endpoint,
					{
						fetchImplementation,
						requestInit: options.requestInit,
						headers: baseHeaders,
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
								rationale: "Native tool call emitted by GitHub Models.",
								arguments: normalizeToolArguments(
									toolCall.function?.arguments,
									`GitHub Models tool call ${toolCall.function?.name ?? "unknown"}`,
								),
							};
						},
					),
				});
			}

			const response = await postJson<GitHubChatCompletionResponse>(endpoint, {
				fetchImplementation,
				requestInit: options.requestInit,
				headers: baseHeaders,
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
			});

			const text = extractGitHubText(response);
			const parsed = parseJsonText<Record<string, unknown>>(
				text,
				`GitHub Models ${request.phase}`,
			);

			return normalizeRenderResponse(parsed);
		},
		stream: async function* (request) {
			const eventStream = await openEventStream(endpoint, {
				fetchImplementation,
				requestInit: options.requestInit,
				headers: {
					...baseHeaders,
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
				const payload = parseJsonText<GitHubChatCompletionStreamResponse>(
					message,
					"GitHub Models stream chunk",
				);
				const delta = extractGitHubDelta(payload);

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
 * Alias for users who look for GitHub Copilot-branded model access.
 *
 * Internally this targets the public GitHub Models inference API rather than an
 * undocumented Copilot-only endpoint.
 */
export const createGitHubCopilotProvider = createGitHubModelsProvider;

function extractGitHubText(response: GitHubChatCompletionResponse): string {
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

	throw new Error("GitHub Models provider did not return a textual response.");
}

function extractGitHubDelta(
	response: GitHubChatCompletionStreamResponse,
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
