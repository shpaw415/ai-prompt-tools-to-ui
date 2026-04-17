import { z, type ZodError, type ZodTypeAny } from "zod";

type Awaitable<T> = T | Promise<T>;

export type AgenticOutputFormat = "html" | "markdown";

export type AgenticRenderStyle = "tailwind" | "inline-css" | "plain-css";

export type AgenticConversationRole = "system" | "user" | "assistant";

export interface AgenticConversationMessage {
	role: AgenticConversationRole;
	content: string;
	timestamp?: string;
	metadata?: Record<string, unknown>;
}

export interface AgenticConversationHistoryProvider {
	name: string;
	get: (
		conversationId: string,
	) => Awaitable<readonly AgenticConversationMessage[]>;
	set: (
		conversationId: string,
		messages: readonly AgenticConversationMessage[],
	) => Awaitable<void>;
	delete?: (conversationId: string) => Awaitable<void>;
}

export interface AgenticRunOptions {
	conversationId?: string;
	correctionAnswer?: AgenticCorrectionAnswer;
}

export type AgenticRouterStatus = "completed" | "needs-user-input";

export type AgenticCorrectionReason =
	| "validation-required"
	| "confirmation-required";

export interface AgenticPendingCorrectionField {
	name: string;
	message: string;
	enumValues?: readonly string[];
	valueType?: "string" | "number";
}

export interface AgenticPendingCorrection {
	reason: AgenticCorrectionReason;
	message: string;
	toolCall: AgenticToolCallPlan;
	fields: readonly AgenticPendingCorrectionField[];
	originalPrompt: string;
	originalSystemInstruction?: string;
	iteration: number;
	confirmationKey?: string;
	confirmationMessage?: string;
	form?: AgenticCorrectionFormMetadata;
}

export interface AgenticCorrectionAnswer {
	pendingCorrection: AgenticPendingCorrection;
	values?: Record<string, unknown>;
	confirmed?: boolean;
}

export interface AgenticInteractiveCorrectionFormOptions {
	callbackName: string;
	pendingCorrectionFieldName?: string;
	conversationIdFieldName?: string;
	confirmedFieldName?: string;
	submitLabel?: string;
	confirmLabel?: string;
}

export interface AgenticCorrectionFormMetadata {
	callbackName: string;
	formId: string;
	pendingCorrectionFieldName: string;
	conversationIdFieldName: string;
	confirmedFieldName: string;
	submitLabel: string;
	confirmLabel: string;
}

interface ResolvedAgenticRouterOptions {
	model: string;
	outputFormat: AgenticOutputFormat;
	renderStyle?: AgenticRenderStyle;
	renderStyleInstruction?: string;
	historyProvider?: AgenticConversationHistoryProvider;
	enableInteractiveCorrections: boolean;
	interactiveCorrectionForm?: AgenticInteractiveCorrectionFormOptions;
	includeHistoryInPlanning: boolean;
	historyWindowSize: number;
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
	conversationHistory?: readonly AgenticConversationMessage[];
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
	conversationHistory?: readonly AgenticConversationMessage[];
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
			type: "needs-user-input";
			response: AgenticRouterResponse;
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
	 * Enables pause/resume corrections for missing tool inputs and confirmations.
	 *
	 * When enabled, the router can stop before tool execution, return a
	 * structured correction payload to the caller, and continue later when the
	 * caller provides the missing values or a confirmation answer.
	 */
	enableInteractiveCorrections?: boolean;
	/**
	 * Optional HTML form metadata for paused correction responses.
	 *
	 * When configured and the router outputs HTML, paused correction responses
	 * render a real form element with callback metadata so the client can attach
	 * its own JavaScript submit handler.
	 */
	interactiveCorrectionForm?: AgenticInteractiveCorrectionFormOptions;
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
	/**
	 * Optional provider used to persist conversation history between runs.
	 */
	historyProvider?: AgenticConversationHistoryProvider;
	/**
	 * Whether prior conversation history should be included during planning.
	 *
	 * When false, history is still persisted and available to the render phase,
	 * but the planner only sees the current prompt and current-run tool results.
	 */
	includeHistoryInPlanning?: boolean;
	/**
	 * Maximum number of persisted messages loaded into a run.
	 *
	 * The window is counted in messages, not turns. A value of `0` disables
	 * loading prior messages while still allowing future writes.
	 */
	historyWindowSize?: number;
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
	conversationId?: string;
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
	options?: AgenticToolOptions;
	handler: AgenticToolHandler<Schema, Result>;
}

export interface AgenticToolOptions {
	requiresConfirmation?: boolean;
	confirmationMessage?: string;
	confirmationKey?: string;
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
	status: AgenticRouterStatus;
	model: string;
	format: AgenticOutputFormat;
	prompt: string;
	systemInstruction?: string;
	content: string;
	toolCalls: AgenticToolExecutionResult[];
	iterations: number;
	pendingCorrection?: AgenticPendingCorrection;
}

interface CompletedToolResolution {
	status: "completed";
	effectivePrompt: string;
	effectiveSystemInstruction?: string;
	historyUserPrompt: string;
	toolResults: AgenticToolExecutionResult[];
	iterations: number;
}

interface PausedToolResolution {
	status: "needs-user-input";
	historyUserPrompt: string;
	response: AgenticRouterResponse;
}

type ToolResolution = CompletedToolResolution | PausedToolResolution;

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
			enableInteractiveCorrections: false,
			includeHistoryInPlanning: true,
			historyWindowSize: 12,
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
		toolOptions?: AgenticToolOptions,
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
			options: toolOptions,
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
		runOptions: AgenticRunOptions = {},
	): Promise<AgenticRouterResponse> {
		const normalizedPrompt = this._normalizePrompt(prompt);
		const conversationHistory = await this._loadConversationHistory(runOptions);
		const resolution = await this._resolveToolCalls(
			normalizedPrompt,
			systemInstruction,
			conversationHistory,
			runOptions,
		);

		if (resolution.status === "needs-user-input") {
			await this._saveConversationTurn(
				runOptions,
				conversationHistory,
				resolution.historyUserPrompt,
				resolution.response,
			);

			return resolution.response;
		}

		const rendered = await this._callLLM({
			phase: "render",
			prompt: resolution.effectivePrompt,
			systemInstruction: resolution.effectiveSystemInstruction,
			outputFormat: this.options.outputFormat,
			renderStyle: this.options.renderStyle,
			renderStyleInstruction: this.options.renderStyleInstruction,
			conversationHistory,
			tools: this._getProviderTools(),
			toolResults: resolution.toolResults,
		});

		const response = {
			status: "completed" as const,
			model: this.options.model,
			format: this.options.outputFormat,
			prompt: resolution.effectivePrompt,
			systemInstruction: resolution.effectiveSystemInstruction,
			content: rendered.content,
			toolCalls: resolution.toolResults,
			iterations: resolution.iterations,
		};

		await this._saveConversationTurn(
			runOptions,
			conversationHistory,
			resolution.historyUserPrompt,
			response,
		);

		return response;
	}

	/**
	 * Runs the full agentic loop and streams render deltas as they arrive.
	 *
	 * Planning and tool execution are completed before the render phase starts.
	 */
	async *runAndRenderStream(
		prompt: string,
		systemInstruction?: string,
		runOptions: AgenticRunOptions = {},
	): AsyncGenerator<AgenticRouterStreamEvent, AgenticRouterResponse, void> {
		const normalizedPrompt = this._normalizePrompt(prompt);
		const conversationHistory = await this._loadConversationHistory(runOptions);
		const planningEvents: AgenticRouterStreamEvent[] = [];
		const resolution = await this._resolveToolCalls(
			normalizedPrompt,
			systemInstruction,
			conversationHistory,
			runOptions,
			planningEvents,
		);

		for (const event of planningEvents) {
			yield event;
		}

		if (resolution.status === "needs-user-input") {
			await this._saveConversationTurn(
				runOptions,
				conversationHistory,
				resolution.historyUserPrompt,
				resolution.response,
			);

			yield {
				type: "needs-user-input",
				response: resolution.response,
			};

			return resolution.response;
		}

		const renderRequest: AgenticLLMRenderRequest = {
			phase: "render",
			prompt: resolution.effectivePrompt,
			systemInstruction: resolution.effectiveSystemInstruction,
			outputFormat: this.options.outputFormat,
			renderStyle: this.options.renderStyle,
			renderStyleInstruction: this.options.renderStyleInstruction,
			conversationHistory,
			tools: this._getProviderTools(),
			toolResults: resolution.toolResults,
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
			status: "completed",
			model: this.options.model,
			format: this.options.outputFormat,
			prompt: resolution.effectivePrompt,
			systemInstruction: resolution.effectiveSystemInstruction,
			content,
			toolCalls: resolution.toolResults,
			iterations: resolution.iterations,
		};

		await this._saveConversationTurn(
			runOptions,
			conversationHistory,
			resolution.historyUserPrompt,
			response,
		);

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
		options: {
			allowConfirmationExecution?: boolean;
		} = {},
	): Promise<AgenticToolExecutionResult> {
		const definition = this.tools.get(plan.toolName);

		if (!definition) {
			throw new Error(`Unknown tool "${plan.toolName}".`);
		}

		if (
			this.options.enableInteractiveCorrections &&
			definition.options?.requiresConfirmation &&
			!options.allowConfirmationExecution
		) {
			throw new Error(
				`Tool "${plan.toolName}" requires confirmation before execution.`,
			);
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
		normalizedPrompt: string,
		systemInstruction?: string,
		conversationHistory?: readonly AgenticConversationMessage[],
		runOptions: AgenticRunOptions = {},
		streamEvents?: AgenticRouterStreamEvent[],
	): Promise<ToolResolution> {
		const effectivePrompt =
			runOptions.correctionAnswer?.pendingCorrection.originalPrompt ??
			normalizedPrompt;
		const effectiveSystemInstruction =
			runOptions.correctionAnswer?.pendingCorrection
				.originalSystemInstruction ?? systemInstruction;
		const historyUserPrompt = normalizedPrompt;
		const toolResults: AgenticToolExecutionResult[] = [];
		let iterations = 0;

		if (runOptions.correctionAnswer) {
			const resumedExecution = await this._resumePendingCorrection(
				runOptions.correctionAnswer,
				{
					prompt: effectivePrompt,
					systemInstruction: effectiveSystemInstruction,
					conversationId: runOptions.conversationId,
					iteration: runOptions.correctionAnswer.pendingCorrection.iteration,
					outputFormat: this.options.outputFormat,
					toolResults,
				},
			);

			iterations = runOptions.correctionAnswer.pendingCorrection.iteration;

			if (resumedExecution.status === "needs-user-input") {
				return {
					status: "needs-user-input",
					historyUserPrompt,
					response: resumedExecution.response,
				};
			}

			toolResults.push(resumedExecution.result);

			if (streamEvents) {
				streamEvents.push({
					type: "tool-result",
					iteration: iterations,
					result: resumedExecution.result,
				});
			}
		}

		while (iterations < this.options.maxIterations) {
			iterations += 1;

			const planning = await this._callLLM({
				phase: "plan",
				prompt: effectivePrompt,
				systemInstruction: effectiveSystemInstruction,
				outputFormat: this.options.outputFormat,
				conversationHistory: this.options.includeHistoryInPlanning
					? conversationHistory
					: undefined,
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
				if (streamEvents) {
					streamEvents.push({
						type: "tool-call",
						iteration: iterations,
						toolCall,
					});
				}

				const execution = await this._tryExecutePlannedToolCall(toolCall, {
					prompt: effectivePrompt,
					systemInstruction: effectiveSystemInstruction,
					conversationId: runOptions.conversationId,
					iteration: iterations,
					outputFormat: this.options.outputFormat,
					toolResults,
				});

				if (execution.status === "needs-user-input") {
					return {
						status: "needs-user-input",
						historyUserPrompt,
						response: execution.response,
					};
				}

				toolResults.push(execution.result);

				if (streamEvents) {
					streamEvents.push({
						type: "tool-result",
						iteration: iterations,
						result: execution.result,
					});
				}
			}
		}

		return {
			status: "completed",
			effectivePrompt,
			effectiveSystemInstruction,
			historyUserPrompt,
			toolResults,
			iterations,
		};
	}

	private async _loadConversationHistory(
		runOptions: AgenticRunOptions,
	): Promise<AgenticConversationMessage[]> {
		if (!runOptions.conversationId || !this.options.historyProvider) {
			return [];
		}

		const messages = await this.options.historyProvider.get(
			runOptions.conversationId,
		);

		return this._trimConversationHistory(messages);
	}

	private async _saveConversationTurn(
		runOptions: AgenticRunOptions,
		existingHistory: readonly AgenticConversationMessage[],
		userPrompt: string,
		response: AgenticRouterResponse,
	): Promise<void> {
		if (!runOptions.conversationId || !this.options.historyProvider) {
			return;
		}

		const timestamp = new Date().toISOString();
		const userMessage: AgenticConversationMessage = {
			role: "user",
			content: userPrompt,
			timestamp,
			metadata: {
				...(response.systemInstruction
					? { systemInstruction: response.systemInstruction }
					: {}),
				...(response.prompt !== userPrompt
					? { correctionTargetPrompt: response.prompt }
					: {}),
			},
		};
		const assistantMessage: AgenticConversationMessage = {
			role: "assistant",
			content: this._buildAssistantHistoryEntry(response),
			timestamp,
			metadata: {
				status: response.status,
				format: response.format,
				iterations: response.iterations,
				pendingCorrection: response.pendingCorrection,
				toolCalls: response.toolCalls.map((toolCall) => {
					return {
						toolName: toolCall.toolName,
						rationale: toolCall.rationale,
						arguments: toolCall.arguments,
						result: toolCall.result,
					};
				}),
			},
		};

		await this.options.historyProvider.set(
			runOptions.conversationId,
			this._trimConversationHistory([
				...existingHistory,
				userMessage,
				assistantMessage,
			]),
		);
	}

	private _trimConversationHistory(
		messages: readonly AgenticConversationMessage[],
	): AgenticConversationMessage[] {
		const historyWindowSize = Math.max(0, this.options.historyWindowSize);

		if (historyWindowSize === 0) {
			return [];
		}

		return [...messages].slice(-historyWindowSize);
	}

	private _buildAssistantHistoryEntry(response: AgenticRouterResponse): string {
		if (response.status === "needs-user-input") {
			return response.pendingCorrection?.message ?? response.content;
		}

		if (response.toolCalls.length === 0) {
			return `Delivered a ${response.format} response without calling any tool.`;
		}

		return [
			`Delivered a ${response.format} response using the following tool results:`,
			JSON.stringify(
				response.toolCalls.map((toolCall) => {
					return {
						toolName: toolCall.toolName,
						rationale: toolCall.rationale,
						arguments: toolCall.arguments,
						result: toolCall.result,
					};
				}),
				null,
				2,
			),
		].join("\n\n");
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
				description: tool.options?.requiresConfirmation
					? `${tool.description} Requires explicit user confirmation before execution.`
					: tool.description,
				schema: tool.schema,
			};
		});
	}

	private async _resumePendingCorrection(
		correctionAnswer: AgenticCorrectionAnswer,
		context: AgenticToolExecutionContext,
	): Promise<
		| { status: "completed"; result: AgenticToolExecutionResult }
		| { status: "needs-user-input"; response: AgenticRouterResponse }
	> {
		const pendingCorrection = correctionAnswer.pendingCorrection;
		const normalizedValues = normalizeCorrectionValues(
			correctionAnswer.values,
			pendingCorrection.fields,
		);
		const mergedToolCall: AgenticToolCallPlan = {
			...pendingCorrection.toolCall,
			arguments: {
				...pendingCorrection.toolCall.arguments,
				...normalizedValues,
			},
		};

		if (
			pendingCorrection.reason === "confirmation-required" &&
			correctionAnswer.confirmed !== true
		) {
			return {
				status: "needs-user-input",
				response: this._buildPausedResponse(
					pendingCorrection,
					context.toolResults,
					context.conversationId,
				),
			};
		}

		return this._tryExecutePlannedToolCall(mergedToolCall, context, {
			allowConfirmationExecution: correctionAnswer.confirmed === true,
		});
	}

	private async _tryExecutePlannedToolCall(
		plan: AgenticToolCallPlan,
		context: AgenticToolExecutionContext,
		options: {
			allowConfirmationExecution?: boolean;
		} = {},
	): Promise<
		| { status: "completed"; result: AgenticToolExecutionResult }
		| { status: "needs-user-input"; response: AgenticRouterResponse }
	> {
		const definition = this.tools.get(plan.toolName);

		if (!definition) {
			throw new Error(`Unknown tool "${plan.toolName}".`);
		}

		const validation = await definition.schema.safeParseAsync(plan.arguments);

		if (!validation.success) {
			if (this.options.enableInteractiveCorrections) {
				return {
					status: "needs-user-input",
					response: this._buildPausedResponse(
						this._createValidationCorrection(
							plan,
							context,
							definition.schema,
							validation.error,
						),
						context.toolResults,
						context.conversationId,
					),
				};
			}

			throw validation.error;
		}

		if (
			this.options.enableInteractiveCorrections &&
			definition.options?.requiresConfirmation &&
			!options.allowConfirmationExecution
		) {
			return {
				status: "needs-user-input",
				response: this._buildPausedResponse(
					this._createConfirmationCorrection(plan, context, definition.options),
					context.toolResults,
					context.conversationId,
				),
			};
		}

		return {
			status: "completed",
			result: await this._executeToolCall(plan, context, options),
		};
	}

	private _createValidationCorrection(
		plan: AgenticToolCallPlan,
		context: AgenticToolExecutionContext,
		schema: ZodTypeAny,
		error: ZodError,
	): AgenticPendingCorrection {
		const fields = this._extractCorrectionFields(error, schema);

		return {
			reason: "validation-required",
			message:
				fields.length > 0
					? `I need more information before I can run ${plan.toolName}. Please provide: ${fields
							.map((field) => field.name)
							.join(", ")}.`
					: `I need corrected input before I can run ${plan.toolName}.`,
			toolCall: plan,
			fields,
			originalPrompt: context.prompt,
			originalSystemInstruction: context.systemInstruction,
			iteration: context.iteration,
		};
	}

	private _createConfirmationCorrection(
		plan: AgenticToolCallPlan,
		context: AgenticToolExecutionContext,
		options: AgenticToolOptions,
	): AgenticPendingCorrection {
		const confirmationMessage =
			options.confirmationMessage ??
			`Please confirm before I run ${plan.toolName}.`;

		return {
			reason: "confirmation-required",
			message: confirmationMessage,
			toolCall: plan,
			fields: [],
			originalPrompt: context.prompt,
			originalSystemInstruction: context.systemInstruction,
			iteration: context.iteration,
			confirmationKey: options.confirmationKey,
			confirmationMessage,
		};
	}

	private _extractCorrectionFields(
		error: ZodError,
		schema: ZodTypeAny,
	): AgenticPendingCorrectionField[] {
		const dedupedFields = new Map<string, AgenticPendingCorrectionField>();

		for (const issue of error.issues) {
			const fieldName = issue.path.length > 0 ? issue.path.join(".") : "input";
			const enumValues = extractIssueEnumValues(issue);
			const valueType = extractCorrectionValueType(schema, issue.path);
			const existingField = dedupedFields.get(fieldName);

			if (!existingField) {
				dedupedFields.set(fieldName, {
					name: fieldName,
					message: issue.message,
					...(enumValues ? { enumValues } : {}),
					...(valueType ? { valueType } : {}),
				});
				continue;
			}

			if (
				(!existingField.enumValues && enumValues) ||
				!existingField.valueType
			) {
				dedupedFields.set(fieldName, {
					...existingField,
					...(existingField.enumValues || !enumValues ? {} : { enumValues }),
					...(existingField.valueType || !valueType ? {} : { valueType }),
				});
			}
		}

		return [...dedupedFields.values()];
	}

	private _buildPausedResponse(
		pendingCorrection: AgenticPendingCorrection,
		toolCalls: readonly AgenticToolExecutionResult[],
		conversationId?: string,
	): AgenticRouterResponse {
		const resolvedPendingCorrection = this._decoratePendingCorrection(
			pendingCorrection,
			conversationId,
		);

		return {
			status: "needs-user-input",
			model: this.options.model,
			format: this.options.outputFormat,
			prompt: resolvedPendingCorrection.originalPrompt,
			systemInstruction: resolvedPendingCorrection.originalSystemInstruction,
			content: this._renderPausedResponseContent(
				resolvedPendingCorrection,
				conversationId,
			),
			toolCalls: [...toolCalls],
			iterations: resolvedPendingCorrection.iteration,
			pendingCorrection: resolvedPendingCorrection,
		};
	}

	private _renderPausedResponseContent(
		pendingCorrection: AgenticPendingCorrection,
		conversationId?: string,
	): string {
		if (this.options.outputFormat === "html") {
			const correctionForm = this.options.interactiveCorrectionForm;

			if (correctionForm) {
				return this._renderPausedResponseForm(
					pendingCorrection,
					conversationId,
					pendingCorrection.form ??
						this._buildCorrectionFormMetadata(pendingCorrection),
				);
			}

			const fields = pendingCorrection.fields.length
				? `<ul>${pendingCorrection.fields
						.map((field) => {
							return `<li><strong>${escapeHtml(field.name)}</strong>: ${escapeHtml(field.message)}</li>`;
						})
						.join("")}</ul>`
				: "";

			return [
				'<article class="agentic-ui agentic-ui-correction">',
				"  <header>",
				"    <h1>Additional Input Required</h1>",
				`    <p>${escapeHtml(pendingCorrection.message)}</p>`,
				"  </header>",
				fields ? `  <section>${fields}</section>` : "",
				"</article>",
			]
				.filter(Boolean)
				.join("\n");
		}

		return [
			"# Additional Input Required",
			"",
			pendingCorrection.message,
			...pendingCorrection.fields.map((field) => {
				return `- ${field.name}: ${field.message}`;
			}),
		].join("\n");
	}

	private _decoratePendingCorrection(
		pendingCorrection: AgenticPendingCorrection,
		conversationId?: string,
	): AgenticPendingCorrection {
		if (
			this.options.outputFormat !== "html" ||
			!this.options.interactiveCorrectionForm
		) {
			return pendingCorrection;
		}

		return {
			...pendingCorrection,
			form:
				pendingCorrection.form ??
				this._buildCorrectionFormMetadata(pendingCorrection, conversationId),
		};
	}

	private _buildCorrectionFormMetadata(
		pendingCorrection: AgenticPendingCorrection,
		conversationId?: string,
	): AgenticCorrectionFormMetadata {
		const formOptions = this.options.interactiveCorrectionForm;

		if (!formOptions) {
			throw new Error(
				"Interactive correction form metadata requested without router configuration.",
			);
		}

		const safeToolName = pendingCorrection.toolCall.toolName
			.replace(/[^a-z0-9_-]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase();
		const conversationSuffix = conversationId
			? `-${conversationId
					.replace(/[^a-z0-9_-]+/gi, "-")
					.replace(/^-+|-+$/g, "")
					.toLowerCase()}`
			: "";

		return {
			callbackName: formOptions.callbackName,
			formId: `agentic-correction-${safeToolName || "form"}-${pendingCorrection.iteration}${conversationSuffix}`,
			pendingCorrectionFieldName:
				formOptions.pendingCorrectionFieldName ?? "agenticPendingCorrection",
			conversationIdFieldName:
				formOptions.conversationIdFieldName ?? "agenticConversationId",
			confirmedFieldName: formOptions.confirmedFieldName ?? "agenticConfirmed",
			submitLabel: formOptions.submitLabel ?? "Continue",
			confirmLabel: formOptions.confirmLabel ?? "Confirm",
		};
	}

	private _renderPausedResponseForm(
		pendingCorrection: AgenticPendingCorrection,
		conversationId: string | undefined,
		form: AgenticCorrectionFormMetadata,
	): string {
		const visibleFields =
			pendingCorrection.reason === "validation-required"
				? pendingCorrection.fields
						.map((field) => {
							return renderCorrectionFieldHtml(field);
						})
						.join("\n")
				: "";
		const hiddenInputs = [
			`    <input type="hidden" name="${escapeHtml(form.pendingCorrectionFieldName)}" value="${escapeHtml(JSON.stringify(pendingCorrection))}" />`,
			`    <input type="hidden" name="${escapeHtml(form.conversationIdFieldName)}" value="${escapeHtml(conversationId ?? "")}" />`,
			pendingCorrection.reason === "confirmation-required"
				? `    <input type="hidden" name="${escapeHtml(form.confirmedFieldName)}" value="true" />`
				: "",
		]
			.filter(Boolean)
			.join("\n");
		const submitLabel =
			pendingCorrection.reason === "confirmation-required"
				? form.confirmLabel
				: form.submitLabel;

		return [
			'<article class="agentic-ui agentic-ui-correction">',
			"  <header>",
			"    <h1>Additional Input Required</h1>",
			`    <p>${escapeHtml(pendingCorrection.message)}</p>`,
			"  </header>",
			`  <form id="${escapeHtml(form.formId)}" class="agentic-correction-form" data-agentic-callback="${escapeHtml(form.callbackName)}" data-agentic-reason="${escapeHtml(pendingCorrection.reason)}" data-agentic-tool-name="${escapeHtml(pendingCorrection.toolCall.toolName)}">`,
			hiddenInputs,
			visibleFields,
			`    <button type="submit">${escapeHtml(submitLabel)}</button>`,
			"  </form>",
			"</article>",
		]
			.filter(Boolean)
			.join("\n");
	}
}

function extractIssueEnumValues(
	issue: ZodError["issues"][number],
): string[] | undefined {
	const candidate = issue as ZodError["issues"][number] & {
		values?: unknown;
	};

	if (!Array.isArray(candidate.values)) {
		return undefined;
	}

	const enumValues = candidate.values.filter((value): value is string => {
		return typeof value === "string";
	});

	if (enumValues.length === 0) {
		return undefined;
	}

	return [...new Set(enumValues)];
}

function renderCorrectionFieldHtml(
	field: AgenticPendingCorrectionField,
): string {
	if (field.enumValues?.length) {
		return [
			'    <label class="agentic-correction-field">',
			`      <span>${escapeHtml(field.name)}</span>`,
			`      <select name="${escapeHtml(field.name)}">`,
			'        <option value="">Select an option</option>',
			...field.enumValues.map((value) => {
				return `        <option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
			}),
			"      </select>",
			"    </label>",
		].join("\n");
	}

	const inputType = field.valueType === "number" ? "number" : "text";
	const extraAttributes =
		field.valueType === "number" ? ' inputmode="decimal" step="any"' : "";

	return [
		'    <label class="agentic-correction-field">',
		`      <span>${escapeHtml(field.name)}</span>`,
		`      <input type="${inputType}" name="${escapeHtml(field.name)}" placeholder="${escapeHtml(field.message)}"${extraAttributes} />`,
		"    </label>",
	].join("\n");
}

function normalizeCorrectionValues(
	values: Record<string, unknown> | undefined,
	fields: readonly AgenticPendingCorrectionField[],
): Record<string, unknown> {
	if (!values) {
		return {};
	}

	const fieldsByName = new Map(fields.map((field) => [field.name, field]));

	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => {
			return [key, coerceCorrectionValue(value, fieldsByName.get(key))];
		}),
	);
}

function coerceCorrectionValue(
	value: unknown,
	field?: AgenticPendingCorrectionField,
): unknown {
	if (field?.valueType === "number" && typeof value === "string") {
		const trimmed = value.trim();

		if (!trimmed) {
			return value;
		}

		const parsed = Number(trimmed);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return value;
}

function extractCorrectionValueType(
	schema: ZodTypeAny,
	path: readonly PropertyKey[],
): AgenticPendingCorrectionField["valueType"] | undefined {
	const resolvedSchema = resolveCorrectionFieldSchema(schema, path);

	if (!resolvedSchema) {
		return undefined;
	}

	return resolvedSchema instanceof z.ZodNumber ? "number" : undefined;
}

function resolveCorrectionFieldSchema(
	schema: ZodTypeAny,
	path: readonly PropertyKey[],
): ZodTypeAny | undefined {
	let current: ZodTypeAny | undefined = unwrapCorrectionSchema(schema);

	for (const segment of path) {
		current = current ? unwrapCorrectionSchema(current) : undefined;

		if (!current) {
			return undefined;
		}

		if (typeof segment === "number") {
			if (current instanceof z.ZodArray) {
				current = unwrapCorrectionSchema(
					(current as unknown as { element?: ZodTypeAny }).element ??
						z.unknown(),
				);
				continue;
			}

			return undefined;
		}

		if (current instanceof z.ZodObject) {
			const shape = current.shape as Record<string, ZodTypeAny>;
			const next: ZodTypeAny | undefined = shape[String(segment)];
			current = next;
			continue;
		}

		return undefined;
	}

	return current ? unwrapCorrectionSchema(current) : undefined;
}

function unwrapCorrectionSchema(schema: ZodTypeAny): ZodTypeAny {
	const candidate = schema as ZodTypeAny & {
		unwrap?: () => ZodTypeAny;
		removeDefault?: () => ZodTypeAny;
	};

	if (typeof candidate.removeDefault === "function") {
		return unwrapCorrectionSchema(candidate.removeDefault());
	}

	if (typeof candidate.unwrap === "function") {
		return unwrapCorrectionSchema(candidate.unwrap());
	}

	return schema;
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
export { createInMemoryHistoryProvider } from "./history/in-memory";
export {
	createBunSQLiteHistoryProvider,
	type BunSQLiteHistoryProviderOptions,
} from "./history/bun-sqlite";
export {
	createCloudflareD1HistoryProvider,
	type CloudflareD1Database,
	type CloudflareD1HistoryProviderOptions,
	type CloudflareD1PreparedStatement,
	type CloudflareD1Result,
} from "./history/cloudflare-d1";
export {
	createCloudflareKVHistoryProvider,
	type CloudflareKVHistoryProviderOptions,
	type CloudflareKVNamespace,
} from "./history/cloudflare-kv";
