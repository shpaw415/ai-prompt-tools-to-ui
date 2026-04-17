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
	toGeminiToolSchema,
	toProviderPrompt,
} from "./shared";

interface GeminiGenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
				functionCall?: { name?: string; args?: unknown };
			}>;
		};
	}>;
}

export interface GoogleProviderOptions<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
> extends HttpAgenticProviderOptions<Metadata> {
	apiVersion?: "v1beta" | "v1";
}

/**
 * Creates a Google Gemini provider using the Generative Language REST API.
 */
export function createGoogleProvider<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
>(
	options: GoogleProviderOptions<Metadata>,
): AgenticLLMProvider<
	Metadata & {
		vendor: "google";
		apiVersion: "v1beta" | "v1";
	},
	HttpAgenticProviderClient
> {
	const fetchImplementation = options.fetchImplementation ?? fetch;
	const baseUrl =
		options.baseUrl ?? "https://generativelanguage.googleapis.com";
	const apiVersion = options.apiVersion ?? "v1beta";

	return {
		name: options.name ?? "google-gemini",
		model: options.model,
		apiKey: options.apiKey,
		baseUrl,
		client: { fetchImplementation },
		metadata: {
			vendor: "google",
			apiVersion,
			...(options.metadata ?? {}),
		} as Metadata & {
			vendor: "google";
			apiVersion: "v1beta" | "v1";
		},
		request: async (request) => {
			if (request.phase === "plan") {
				const response = await postJson<GeminiGenerateContentResponse>(
					`${baseUrl}/${apiVersion}/models/${options.model}:generateContent?key=${encodeURIComponent(options.apiKey)}`,
					{
						fetchImplementation,
						requestInit: options.requestInit,
						headers: {
							...options.headers,
						},
						body: {
							systemInstruction: {
								parts: [
									{
										text: "You are a planning engine. Use native function calls when needed. If no tool is needed, do not emit any function call.",
									},
								],
							},
							contents: [
								{
									role: "user",
									parts: [{ text: buildNativePlanPrompt(request) }],
								},
							],
							tools: [
								{
									functionDeclarations: request.tools.map((tool) => {
										return {
											name: tool.name,
											description: tool.description,
											parameters: toGeminiToolSchema(
												buildToolJsonSchema(tool.schema),
											),
										};
									}),
								},
							],
							toolConfig: {
								functionCallingConfig: {
									mode: "AUTO",
									allowedFunctionNames: request.tools.map((tool) => tool.name),
								},
							},
							generationConfig: {
								temperature: 0,
							},
						},
					},
				);

				return normalizePlanResponse({
					toolCalls: extractGeminiFunctionCalls(response),
				});
			}

			const response = await postJson<GeminiGenerateContentResponse>(
				`${baseUrl}/${apiVersion}/models/${options.model}:generateContent?key=${encodeURIComponent(options.apiKey)}`,
				{
					fetchImplementation,
					requestInit: options.requestInit,
					headers: {
						...options.headers,
					},
					body: {
						systemInstruction: {
							parts: [
								{
									text: "You are a structured JSON API for an agentic router. Return JSON only.",
								},
							],
						},
						contents: [
							{
								role: "user",
								parts: [{ text: toProviderPrompt(request) }],
							},
						],
						generationConfig: {
							temperature: 0,
							responseMimeType: "application/json",
						},
					},
				},
			);

			const text = extractGeminiText(response);
			const parsed = parseJsonText<Record<string, unknown>>(
				text,
				`Google ${request.phase}`,
			);

			return normalizeRenderResponse(parsed);
		},
		stream: async function* (request) {
			const eventStream = await openEventStream(
				`${baseUrl}/${apiVersion}/models/${options.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(options.apiKey)}`,
				{
					fetchImplementation,
					requestInit: options.requestInit,
					headers: {
						...options.headers,
					},
					body: {
						systemInstruction: {
							parts: [
								{
									text: "You are a streaming render engine for an agentic router. Return only the final rendered output.",
								},
							],
						},
						contents: [
							{
								role: "user",
								parts: [{ text: buildRenderStreamPrompt(request) }],
							},
						],
						generationConfig: {
							temperature: 0,
						},
					},
				},
			);

			let content = "";

			for await (const message of iterateSSEMessages(eventStream)) {
				const payload = parseJsonText<GeminiGenerateContentResponse>(
					message,
					"Google stream chunk",
				);
				const delta = extractGeminiDelta(payload);

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
 * Alias for consumers who prefer Gemini naming.
 */
export const createGeminiProvider = createGoogleProvider;

function extractGeminiText(response: GeminiGenerateContentResponse): string {
	const parts = response.candidates?.[0]?.content?.parts ?? [];
	const text = parts
		.map((part) => {
			return typeof part.text === "string" ? part.text : "";
		})
		.join("\n")
		.trim();

	if (!text) {
		throw new Error("Google provider did not return a textual response.");
	}

	return text;
}

function extractGeminiDelta(response: GeminiGenerateContentResponse): string {
	const parts = response.candidates?.[0]?.content?.parts ?? [];

	return parts
		.map((part) => {
			return typeof part.text === "string" ? part.text : "";
		})
		.join("");
}

function extractGeminiFunctionCalls(
	response: GeminiGenerateContentResponse,
): Array<{
	toolName: string;
	rationale: string;
	arguments: Record<string, unknown>;
}> {
	return (response.candidates?.[0]?.content?.parts ?? [])
		.filter((part) => typeof part.functionCall?.name === "string")
		.map((part) => {
			return {
				toolName: part.functionCall?.name ?? "unknown_tool",
				rationale: "Native tool call emitted by Gemini.",
				arguments: normalizeToolArguments(
					part.functionCall?.args,
					`Gemini tool call ${part.functionCall?.name ?? "unknown"}`,
				),
			};
		});
}
