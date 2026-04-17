import type { FrameMasterPlugin } from "frame-master/plugin/types";
import { z, type ZodTypeAny } from "zod";
import { name, version } from "./package.json";

type Awaitable<T> = T | Promise<T>;

export type AgenticOutputFormat = "html" | "markdown";

export type AgenticRenderStyle = "tailwind" | "inline-css" | "plain-css";

interface ResolvedAgenticRouterOptions {
	model: string;
	outputFormat: AgenticOutputFormat;
	renderStyle?: AgenticRenderStyle;
	renderStyleInstruction?: string;
	maxIterations: number;
	useStreaming: boolean;
	provider: AgenticLLMProvider;
}

/**
 * Provider-facing tool descriptor stripped from runtime handlers.
 */
export interface AgenticLLMToolDescriptor<
	Schema extends ZodTypeAny = ZodTypeAny,
> {
	name: string;
	description: string;
	schema: Schema;
}

/**
 * Planning request sent to the configured LLM provider.
 */
export interface AgenticLLMPlanRequest {
	phase: "plan";
	prompt: string;
	systemInstruction?: string;
	outputFormat: AgenticOutputFormat;
	tools: readonly AgenticLLMToolDescriptor[];
	toolResults: readonly AgenticToolExecutionResult[];
	maxToolCalls: number;
}

/**
 * Planning response returned by the LLM provider.
 */
export interface AgenticLLMPlanResponse {
	phase: "plan";
	toolCalls: AgenticToolCallPlan[];
}

/**
 * Rendering request sent to the configured LLM provider.
 */
export interface AgenticLLMRenderRequest {
	phase: "render";
	prompt: string;
	systemInstruction?: string;
	outputFormat: AgenticOutputFormat;
	renderStyle?: AgenticRenderStyle;
	renderStyleInstruction?: string;
	tools: readonly AgenticLLMToolDescriptor[];
	toolResults: readonly AgenticToolExecutionResult[];
}

/**
 * Rendering response returned by the LLM provider.
 */
export interface AgenticLLMRenderResponse {
	phase: "render";
	content: string;
}

/**
 * Incremental render chunk emitted by a provider stream.
 */
export interface AgenticLLMRenderStreamChunk {
	phase: "render";
	delta: string;
	content: string;
}

/**
 * Union of all requests that a provider can receive from the router.
 */
export type AgenticLLMProviderRequest =
	| AgenticLLMPlanRequest
	| AgenticLLMRenderRequest;

/**
 * Union of all responses that a provider can return to the router.
 */
export type AgenticLLMProviderResponse =
	| AgenticLLMPlanResponse
	| AgenticLLMRenderResponse;

/**
 * Stream events yielded by {@link AgenticRouter.runAndRenderStream}.
 */
export type AgenticRouterStreamEvent =
	| {
			type: "tool-call";
			iteration: number;
			toolCall: AgenticToolCallPlan;
	  }
	| {
			type: "tool-result";
			iteration: number;
			result: AgenticToolExecutionResult;
	  }
	| {
			type: "render";
			delta: string;
			content: string;
	  }
	| {
			type: "done";
			response: AgenticRouterResponse;
	  };

/**
 * Generic provider contract used to plug any LLM SDK into the router.
 *
 * The provider owns SDK-specific concerns such as API keys, client instances,
 * model identifiers, custom headers, or base URLs. The router only requires a
 * `request` function that understands planning and rendering payloads.
 */
export interface AgenticLLMProvider<
	Metadata extends Record<string, unknown> = Record<string, unknown>,
	Client = unknown,
> {
	name: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
	client?: Client;
	metadata?: Metadata;
	request: (
		request: AgenticLLMProviderRequest,
	) => Awaitable<AgenticLLMProviderResponse>;
	stream?: (
		request: AgenticLLMRenderRequest,
	) => AsyncIterable<AgenticLLMRenderStreamChunk>;
}

/**
 * Options for the built-in mock provider.
 */
export interface MockLLMProviderOptions {
	name?: string;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Runtime options for the {@link AgenticRouter}.
 */
export interface AgenticRouterOptions {
	/**
	 * Optional model identifier used by the default mock provider.
	 *
	 * If `provider` is supplied, the provider's own `model` field becomes the
	 * authoritative value exposed by the router response.
	 */
	model?: string;
	/**
	 * Modular provider definition used to integrate any LLM SDK.
	 */
	provider?: AgenticLLMProvider;
	/** Desired render target for the generated UI payload. */
	outputFormat?: AgenticOutputFormat;
	/**
	 * Optional styling strategy requested from the render model.
	 *
	 * This influences how HTML output should be styled, for example with
	 * Tailwind utility classes, inline styles, or a plain CSS block.
	 */
	renderStyle?: AgenticRenderStyle;
	/**
	 * Additional rendering constraints appended to the style guidance.
	 *
	 * Use this for design-specific instructions such as spacing, typography,
	 * component density, or a restricted class naming scheme.
	 */
	renderStyleInstruction?: string;
	/** Maximum planning iterations before the router forces a render. */
	maxIterations?: number;
	/**
	 * Enables provider-backed streaming during `runAndRenderStream()`.
	 *
	 * When false, the stream API still works but falls back to a single buffered
	 * render chunk generated through the provider `request()` method.
	 */
	useStreaming?: boolean;
}

/**
 * Execution context injected into each tool handler.
 */
export interface AgenticToolExecutionContext {
	prompt: string;
	systemInstruction?: string;
	iteration: number;
	outputFormat: AgenticOutputFormat;
	toolResults: readonly AgenticToolExecutionResult[];
}

/**
 * Registered tool metadata.
 */
export interface AgenticToolDefinition<
	Schema extends ZodTypeAny = ZodTypeAny,
	Result = unknown,
> {
	name: string;
	description: string;
	schema: Schema;
	handler: AgenticToolHandler<Schema, Result>;
}

/**
 * Handler signature used by tools registered with the router.
 */
export type AgenticToolHandler<
	Schema extends ZodTypeAny = ZodTypeAny,
	Result = unknown,
> = (
	input: z.output<Schema>,
	context: AgenticToolExecutionContext,
) => Awaitable<Result>;

/**
 * A tool call proposed by the mock LLM planner.
 */
export interface AgenticToolCallPlan {
	toolName: string;
	rationale: string;
	arguments: Record<string, unknown>;
}

/**
 * Materialized result of a tool execution.
 */
export interface AgenticToolExecutionResult {
	toolName: string;
	rationale: string;
	arguments: Record<string, unknown>;
	result: unknown;
	durationMs: number;
}

/**
 * Final render payload returned to the consumer.
 */
export interface AgenticRouterResponse {
	model: string;
	format: AgenticOutputFormat;
	prompt: string;
	systemInstruction?: string;
	content: string;
	toolCalls: AgenticToolExecutionResult[];
	iterations: number;
}

/**
 * Plugin factory options.
 */
export interface AgenticUIPluginOptions {
	priority?: number;
	routerOptions?: AgenticRouterOptions;
}

/**
 * Agentic router responsible for planning tool calls and returning renderable UI.
 *
 * The current implementation ships with a mock LLM adapter so the orchestration,
 * typing, and validation layers can be exercised without API keys.
 */
export class AgenticRouter {
	private readonly options: ResolvedAgenticRouterOptions;

	private readonly tools = new Map<string, AgenticToolDefinition>();

	/**
	 * Creates a new agentic router instance.
	 */
	constructor(options: AgenticRouterOptions) {
		const provider =
			options.provider ??
			createMockLLMProvider({
				model: options.model,
			});

		this.options = {
			outputFormat: "markdown",
			maxIterations: 3,
			useStreaming: false,
			...options,
			model: provider.model,
			provider,
		};
	}

	/**
	 * Registers an internal tool callable by the planner.
	 *
	 * @param name Unique tool identifier.
	 * @param description Human-readable capability description shown to the planner.
	 * @param schema Zod schema used to validate extracted arguments before execution.
	 * @param handler Async business logic invoked after schema validation succeeds.
	 * @returns The current router instance for chaining.
	 */
	registerTool<Schema extends ZodTypeAny, Result>(
		name: string,
		description: string,
		schema: Schema,
		handler: AgenticToolHandler<Schema, Result>,
	): this {
		if (!name.trim()) {
			throw new Error("Tool name must be a non-empty string.");
		}

		if (this.tools.has(name)) {
			throw new Error(`Tool "${name}" is already registered.`);
		}

		this.tools.set(name, {
			name,
			description,
			schema,
			handler,
		});

		return this;
	}

	/**
	 * Runs the planning loop, executes required tools, and renders the final UI string.
	 *
	 * @param prompt Natural language input from the end user.
	 * @param systemInstruction Optional system-level directive passed to the planner and renderer.
	 */
	async runAndRender(
		prompt: string,
		systemInstruction?: string,
	): Promise<AgenticRouterResponse> {
		const { normalizedPrompt, toolResults, iterations } =
			await this._resolveToolCalls(prompt, systemInstruction);

		const rendered = await this._callLLM({
			phase: "render",
			prompt: normalizedPrompt,
			systemInstruction,
			outputFormat: this.options.outputFormat,
			renderStyle: this.options.renderStyle,
			renderStyleInstruction: this.options.renderStyleInstruction,
			tools: this._getProviderTools(),
			toolResults,
		});

		return {
			model: this.options.model,
			format: this.options.outputFormat,
			prompt: normalizedPrompt,
			systemInstruction,
			content: rendered.content,
			toolCalls: toolResults,
			iterations,
		};
	}

	/**
	 * Runs the full agentic loop and streams render deltas as they arrive.
	 *
	 * Planning and tool execution are completed before the render phase starts.
	 */
	async *runAndRenderStream(
		prompt: string,
		systemInstruction?: string,
	): AsyncGenerator<AgenticRouterStreamEvent, AgenticRouterResponse, void> {
		const normalizedPrompt = this._normalizePrompt(prompt);
		const toolResults: AgenticToolExecutionResult[] = [];
		let iterations = 0;

		while (iterations < this.options.maxIterations) {
			iterations += 1;

			const planning = await this._callLLM({
				phase: "plan",
				prompt: normalizedPrompt,
				systemInstruction,
				outputFormat: this.options.outputFormat,
				tools: this._getProviderTools(),
				toolResults,
				maxToolCalls: 2,
			});

			if (planning.toolCalls.length === 0) {
				break;
			}

			const nextCalls = this._getNextToolCalls(planning.toolCalls, toolResults);

			if (nextCalls.length === 0) {
				break;
			}

			for (const toolCall of nextCalls) {
				yield {
					type: "tool-call",
					iteration: iterations,
					toolCall,
				};
			}

			const executedCalls = await Promise.all(
				nextCalls.map((call) => {
					return this._executeToolCall(call, {
						prompt: normalizedPrompt,
						systemInstruction,
						iteration: iterations,
						outputFormat: this.options.outputFormat,
						toolResults,
					});
				}),
			);

			toolResults.push(...executedCalls);

			for (const result of executedCalls) {
				yield {
					type: "tool-result",
					iteration: iterations,
					result,
				};
			}
		}

		const renderRequest: AgenticLLMRenderRequest = {
			phase: "render",
			prompt: normalizedPrompt,
			systemInstruction,
			outputFormat: this.options.outputFormat,
			renderStyle: this.options.renderStyle,
			renderStyleInstruction: this.options.renderStyleInstruction,
			tools: this._getProviderTools(),
			toolResults,
		};
		let content = "";

		for await (const chunk of this._streamLLM(renderRequest)) {
			content = chunk.content;

			if (!chunk.delta) {
				continue;
			}

			yield {
				type: "render",
				delta: chunk.delta,
				content: chunk.content,
			};
		}

		const response: AgenticRouterResponse = {
			model: this.options.model,
			format: this.options.outputFormat,
			prompt: normalizedPrompt,
			systemInstruction,
			content,
			toolCalls: toolResults,
			iterations,
		};

		yield {
			type: "done",
			response,
		};

		return response;
	}

	/**
	 * Validates a planned call and executes the bound handler.
	 */
	private async _executeToolCall(
		plan: AgenticToolCallPlan,
		context: AgenticToolExecutionContext,
	): Promise<AgenticToolExecutionResult> {
		const definition = this.tools.get(plan.toolName);

		if (!definition) {
			throw new Error(`Unknown tool "${plan.toolName}".`);
		}

		const startedAt = performance.now();
		const validatedArguments = await definition.schema.parseAsync(
			plan.arguments,
		);
		const result = await definition.handler(validatedArguments, context);

		return {
			toolName: plan.toolName,
			rationale: plan.rationale,
			arguments: validatedArguments as Record<string, unknown>,
			result,
			durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
		};
	}

	/**
	 * Calls the configured provider and validates response phase consistency.
	 */
	private async _callLLM(
		request: AgenticLLMPlanRequest,
	): Promise<AgenticLLMPlanResponse>;
	private async _callLLM(
		request: AgenticLLMRenderRequest,
	): Promise<AgenticLLMRenderResponse>;
	private async _callLLM(
		request: AgenticLLMProviderRequest,
	): Promise<AgenticLLMProviderResponse> {
		const response = await this.options.provider.request(request);

		if (response.phase !== request.phase) {
			throw new Error(
				`LLM provider "${this.options.provider.name}" returned a ${response.phase} response for a ${request.phase} request.`,
			);
		}

		return response;
	}

	/**
	 * Streams render chunks from the provider, or falls back to a single response.
	 */
	private async *_streamLLM(
		request: AgenticLLMRenderRequest,
	): AsyncGenerator<AgenticLLMRenderStreamChunk, void, void> {
		if (!this.options.useStreaming || !this.options.provider.stream) {
			const fallback = await this._callLLM(request);
			yield {
				phase: "render",
				delta: fallback.content,
				content: fallback.content,
			};
			return;
		}

		let emitted = false;

		for await (const chunk of this.options.provider.stream(request)) {
			if (chunk.phase !== request.phase) {
				throw new Error(
					`LLM provider "${this.options.provider.name}" returned a ${chunk.phase} stream chunk for a ${request.phase} request.`,
				);
			}

			emitted = true;
			yield chunk;
		}

		if (!emitted) {
			const fallback = await this._callLLM(request);
			yield {
				phase: "render",
				delta: fallback.content,
				content: fallback.content,
			};
		}
	}

	/**
	 * Resolves planning and tool execution before the final render phase.
	 */
	private async _resolveToolCalls(
		prompt: string,
		systemInstruction?: string,
	): Promise<{
		normalizedPrompt: string;
		toolResults: AgenticToolExecutionResult[];
		iterations: number;
	}> {
		const normalizedPrompt = this._normalizePrompt(prompt);
		const toolResults: AgenticToolExecutionResult[] = [];
		let iterations = 0;

		while (iterations < this.options.maxIterations) {
			iterations += 1;

			const planning = await this._callLLM({
				phase: "plan",
				prompt: normalizedPrompt,
				systemInstruction,
				outputFormat: this.options.outputFormat,
				tools: this._getProviderTools(),
				toolResults,
				maxToolCalls: 2,
			});

			if (planning.toolCalls.length === 0) {
				break;
			}

			const nextCalls = this._getNextToolCalls(planning.toolCalls, toolResults);

			if (nextCalls.length === 0) {
				break;
			}

			const executedCalls = await Promise.all(
				nextCalls.map((call) => {
					return this._executeToolCall(call, {
						prompt: normalizedPrompt,
						systemInstruction,
						iteration: iterations,
						outputFormat: this.options.outputFormat,
						toolResults,
					});
				}),
			);

			toolResults.push(...executedCalls);
		}

		return {
			normalizedPrompt,
			toolResults,
			iterations,
		};
	}

	/**
	 * Validates the prompt before entering planning or rendering.
	 */
	private _normalizePrompt(prompt: string): string {
		const normalizedPrompt = prompt.trim();

		if (!normalizedPrompt) {
			throw new Error("Prompt must be a non-empty string.");
		}

		return normalizedPrompt;
	}

	/**
	 * Filters out tool calls that were already executed with the same arguments.
	 */
	private _getNextToolCalls(
		plannedCalls: readonly AgenticToolCallPlan[],
		toolResults: readonly AgenticToolExecutionResult[],
	): AgenticToolCallPlan[] {
		return plannedCalls.filter((call) => {
			return !toolResults.some((result) => {
				return (
					result.toolName === call.toolName &&
					JSON.stringify(result.arguments) === JSON.stringify(call.arguments)
				);
			});
		});
	}

	/**
	 * Builds the provider-facing tool list without exposing runtime handlers.
	 */
	private _getProviderTools(): AgenticLLMToolDescriptor[] {
		return [...this.tools.values()].map((tool) => {
			return {
				name: tool.name,
				description: tool.description,
				schema: tool.schema,
			};
		});
	}
}

/**
 * Creates the default mock provider used when no external SDK provider is supplied.
 */
export function createMockLLMProvider(
	options: MockLLMProviderOptions = {},
): AgenticLLMProvider {
	return {
		name: options.name ?? "mock-llm-provider",
		model: options.model ?? "mock-agentic-llm",
		apiKey: options.apiKey,
		baseUrl: options.baseUrl,
		metadata: options.metadata,
		request: async (
			request: AgenticLLMProviderRequest,
		): Promise<AgenticLLMProviderResponse> => {
			if (request.phase === "plan") {
				const rankedTools = rankTools(request.prompt, request.tools).filter(
					(tool) => {
						return !request.toolResults.some(
							(result) => result.toolName === tool.name,
						);
					},
				);

				const toolCalls = rankedTools
					.slice(0, request.maxToolCalls)
					.flatMap((tool) => {
						const argumentsObject = extractArgumentsFromSchema(
							tool.schema,
							request.prompt,
						);
						const validation = tool.schema.safeParse(argumentsObject);

						if (!validation.success) {
							return [];
						}

						return [
							{
								toolName: tool.name,
								rationale: `Selected ${tool.name} because the prompt overlaps with the tool description.`,
								arguments: validation.data as Record<string, unknown>,
							},
						];
					});

				return {
					phase: "plan",
					toolCalls,
				};
			}

			return {
				phase: "render",
				content:
					request.outputFormat === "html"
						? renderHtmlResponse(
								request.prompt,
								request.systemInstruction,
								request.toolResults,
							)
						: renderMarkdownResponse(
								request.prompt,
								request.systemInstruction,
								request.toolResults,
							),
			};
		},
		stream: async function* (
			request: AgenticLLMRenderRequest,
		): AsyncGenerator<AgenticLLMRenderStreamChunk, void, void> {
			const content =
				request.outputFormat === "html"
					? renderHtmlResponse(
							request.prompt,
							request.systemInstruction,
							request.toolResults,
						)
					: renderMarkdownResponse(
							request.prompt,
							request.systemInstruction,
							request.toolResults,
						);

			yield {
				phase: "render",
				delta: content,
				content,
			};
		},
	};
}

/**
 * Scores tools against the prompt using lightweight keyword heuristics.
 */
function rankTools(
	prompt: string,
	tools: readonly AgenticLLMToolDescriptor[],
): AgenticLLMToolDescriptor[] {
	const promptText = prompt.toLowerCase();
	const promptTokens = new Set(tokenize(promptText));

	return tools
		.map((tool) => {
			const toolText = `${tool.name} ${tool.description}`.toLowerCase();
			const toolTokens = new Set(tokenize(toolText));
			let score = promptText.includes(tool.name.toLowerCase()) ? 6 : 0;

			for (const token of toolTokens) {
				if (promptTokens.has(token)) {
					score += 1;
				}
			}

			return { tool, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score)
		.map((entry) => entry.tool);
}

/**
 * Extracts primitive arguments from the prompt by reflecting on the Zod schema.
 */
function extractArgumentsFromSchema(
	schema: ZodTypeAny,
	prompt: string,
): Record<string, unknown> {
	if (!(schema instanceof z.ZodObject)) {
		return { input: prompt };
	}

	const values: Record<string, unknown> = {};

	for (const [key, valueSchema] of Object.entries(schema.shape)) {
		const extractedValue = extractArgumentValue(key, valueSchema, prompt);
		if (extractedValue !== undefined) {
			values[key] = extractedValue;
		}
	}

	return values;
}

/**
 * Attempts to coerce a single field from the prompt.
 */
function extractArgumentValue(
	key: string,
	schema: ZodTypeAny,
	prompt: string,
): unknown {
	const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	const baseSchema = unwrapSchema(schema);
	const escapedKey = normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const promptText = prompt.trim();

	if (baseSchema instanceof z.ZodString) {
		const keyedMatch = promptText.match(
			new RegExp(`${escapedKey}\\s*(?:=|:|is)?\\s*["']?([^,.;\\n]+)`, "i"),
		);

		if (keyedMatch?.[1]) {
			return keyedMatch[1].trim();
		}

		return shouldUsePromptAsFallback(normalizedKey, schema)
			? promptText
			: undefined;
	}

	if (baseSchema instanceof z.ZodNumber) {
		const numberMatch = promptText.match(
			new RegExp(`${escapedKey}\\s*(?:=|:|is)?\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
		);

		return numberMatch?.[1] ? Number(numberMatch[1]) : undefined;
	}

	if (baseSchema instanceof z.ZodBoolean) {
		const booleanMatch = promptText.match(
			new RegExp(`${escapedKey}\\s*(?:=|:|is)?\\s*(true|false|yes|no)`, "i"),
		);

		if (!booleanMatch?.[1]) {
			return undefined;
		}

		return ["true", "yes"].includes(booleanMatch[1].toLowerCase());
	}

	const enumValues = extractEnumValues(baseSchema);

	if (enumValues.length > 0) {
		return enumValues.find((option) => {
			return promptText.toLowerCase().includes(option.toLowerCase());
		});
	}

	if (baseSchema instanceof z.ZodArray) {
		const keyedMatch = promptText.match(
			new RegExp(`${escapedKey}\\s*(?:=|:)?\\s*([^\\n]+)`, "i"),
		);

		if (!keyedMatch?.[1]) {
			return undefined;
		}

		return keyedMatch[1]
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	return undefined;
}

/**
 * Unwraps optional, nullable, or defaulted schemas to inspect their primitive base type.
 */
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

/**
 * Extracts enum values across Zod 3 and Zod 4 shapes.
 */
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

/**
 * Decides whether a field may safely fall back to the raw prompt text.
 */
function shouldUsePromptAsFallback(key: string, schema: ZodTypeAny): boolean {
	const permissiveKeys = new Set([
		"input",
		"message",
		"prompt",
		"query",
		"question",
		"text",
		"topic",
		"location",
		"city",
	]);

	return permissiveKeys.has(key) && !isCollectionSchema(schema);
}

/**
 * Detects whether a field resolves to a collection-like schema.
 */
function isCollectionSchema(schema: ZodTypeAny): boolean {
	const baseSchema = unwrapSchema(schema);
	return baseSchema instanceof z.ZodArray || baseSchema instanceof z.ZodObject;
}

/**
 * Tokenizes free-form text for keyword-based scoring.
 */
function tokenize(value: string): string[] {
	return value.match(/[a-z0-9]+/g)?.filter((token) => token.length > 2) ?? [];
}

/**
 * Builds a Markdown payload suitable for server-side rendering or streaming.
 */
function renderMarkdownResponse(
	prompt: string,
	systemInstruction: string | undefined,
	toolResults: readonly AgenticToolExecutionResult[],
): string {
	const header = "# Agentic UI Response";
	const intro = systemInstruction
		? `> System instruction: ${systemInstruction}`
		: "> System instruction: none";
	const body = toolResults.length
		? toolResults
				.map((result) => {
					return [
						`## Tool: ${result.toolName}`,
						`Rationale: ${result.rationale}`,
						`Duration: ${result.durationMs} ms`,
						"```json",
						JSON.stringify(result.result, null, 2),
						"```",
					].join("\n");
				})
				.join("\n\n")
		: "## Tool Results\nNo tool call was required for this prompt.";

	return [header, intro, "", `## User Prompt\n${prompt}`, "", body].join("\n");
}

/**
 * Builds an HTML payload ready to inject into a render pipeline.
 */
function renderHtmlResponse(
	prompt: string,
	systemInstruction: string | undefined,
	toolResults: readonly AgenticToolExecutionResult[],
): string {
	const cards = toolResults.length
		? toolResults
				.map((result) => {
					return [
						'<section class="agentic-tool-card">',
						`  <h2>${escapeHtml(result.toolName)}</h2>`,
						`  <p>${escapeHtml(result.rationale)}</p>`,
						`  <small>${result.durationMs.toFixed(2)} ms</small>`,
						`  <pre><code>${escapeHtml(JSON.stringify(result.result, null, 2))}</code></pre>`,
						"</section>",
					].join("\n");
				})
				.join("\n")
		: '<section class="agentic-tool-card"><p>No tool call was required for this prompt.</p></section>';

	return [
		'<article class="agentic-ui">',
		"  <header>",
		"    <h1>Agentic UI Response</h1>",
		`    <p>${escapeHtml(systemInstruction ?? "No system instruction provided.")}</p>`,
		"  </header>",
		`  <section><h2>User Prompt</h2><p>${escapeHtml(prompt)}</p></section>`,
		`  <div class="agentic-tool-results">${cards}</div>`,
		"</article>",
	].join("\n");
}

/**
 * Escapes unsafe HTML characters in text content.
 */
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Convenience helper mirroring the class constructor for functional setups.
 */
export function createAgenticRouter(
	options: AgenticRouterOptions,
): AgenticRouter {
	return new AgenticRouter(options);
}

/**
 * Frame-Master plugin entry point.
 */
export default function frameMasterPluginAgenticUI(
	options: AgenticUIPluginOptions = {},
): FrameMasterPlugin {
	const routerOptions = options.routerOptions ?? {
		model: "mock-agentic-llm",
		outputFormat: "markdown" as const,
	};
	const providerName = routerOptions.provider?.name ?? "mock-llm-provider";
	const providerModel =
		routerOptions.provider?.model ?? routerOptions.model ?? "mock-agentic-llm";

	return {
		name,
		version,
		priority: options.priority ?? 100,
		serverStart: {
			main: async () => {
				console.log(
					`[${name}] ready with provider=${providerName} model=${providerModel} format=${routerOptions.outputFormat ?? "markdown"}`,
				);
			},
			dev_main: async () => {
				console.log(`[${name}] development mode enabled`);
			},
		},
		requirement: {
			frameMasterVersion: "^1.0.0",
			bunVersion: ">=1.2.0",
		},
	};
}

export { z };
export {
	createOpenAIProvider,
	createChatGPTProvider,
	type OpenAIProviderOptions,
} from "./provider/openai";
export {
	createGoogleProvider,
	createGeminiProvider,
	type GoogleProviderOptions,
} from "./provider/google";
export {
	createAnthropicProvider,
	createClaudeProvider,
	type AnthropicProviderOptions,
} from "./provider/anthropic";
export {
	createGitHubModelsProvider,
	createGitHubCopilotProvider,
	type GitHubModelsProviderOptions,
} from "./provider/github";
