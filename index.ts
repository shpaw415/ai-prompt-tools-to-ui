import { z, type ZodError, type ZodTypeAny } from "zod";

type Awaitable<T> = T | Promise<T>;

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
}

export interface AgenticCorrectionAnswer {
	pendingCorrection: AgenticPendingCorrection;
	values?: Record<string, unknown>;
	confirmed?: boolean;
}

interface ResolvedAgenticRouterOptions {
	model: string;
	responseResolver?: AgenticResponseResolver;
	historyProvider?: AgenticConversationHistoryProvider;
	enableInteractiveCorrections: boolean;
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
 * Final response request sent to the configured LLM provider.
 */
export interface AgenticLLMResponseRequest {
	phase: "respond";
	prompt: string;
	systemInstruction?: string;
	conversationHistory?: readonly AgenticConversationMessage[];
	tools: readonly AgenticLLMToolDescriptor[];
	toolResults: readonly AgenticToolExecutionResult[];
}

/**
 * Final response returned by the LLM provider.
 */
export interface AgenticLLMResponseResponse {
	phase: "respond";
	content: string;
}

/**
 * Incremental response chunk emitted by a provider stream.
 */
export interface AgenticLLMResponseStreamChunk {
	phase: "respond";
	delta: string;
	content: string;
}

/**
 * Union of all requests that a provider can receive from the router.
 */
export type AgenticLLMProviderRequest =
	| AgenticLLMPlanRequest
	| AgenticLLMResponseRequest;

/**
 * Union of all responses that a provider can return to the router.
 */
export type AgenticLLMProviderResponse =
	| AgenticLLMPlanResponse
	| AgenticLLMResponseResponse;

/**
 * Optional deterministic response hook that can bypass the provider response phase.
 *
 * Return `undefined` to fall back to the configured LLM provider.
 */
export type AgenticResponseResolver = (
	request: AgenticLLMResponseRequest,
) => Awaitable<AgenticLLMResponseResponse | undefined>;

/**
 * Stream events yielded by {@link AgenticRouter.runAndRespondStream}.
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
			type: "response";
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
 * `request` function that understands planning and final-response payloads.
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
		request: AgenticLLMResponseRequest,
	) => AsyncIterable<AgenticLLMResponseStreamChunk>;
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
	/**
	 * Enables pause/resume corrections for missing tool inputs and confirmations.
	 *
	 * When enabled, the router can stop before tool execution, return a
	 * structured correction payload to the caller, and continue later when the
	 * caller provides the missing values or a confirmation answer.
	 */
	enableInteractiveCorrections?: boolean;
	/**
	 * Optional deterministic summary hook executed before the provider response call.
	 */
	responseResolver?: AgenticResponseResolver;
	/**
	 * Optional provider used to persist conversation history between runs.
	 */
	historyProvider?: AgenticConversationHistoryProvider;
	/**
	 * Whether prior conversation history should be included during planning.
	 *
	 * When false, history is still persisted and available to the response phase,
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
	/** Maximum planning iterations before the router forces a final response. */
	maxIterations?: number;
	/**
	 * Enables provider-backed streaming during `runAndRespondStream()`.
	 *
	 * When false, the stream API still works but falls back to a single buffered
	 * response chunk generated through the provider `request()` method.
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
	isMutation?: boolean;
	intentKeywords?: readonly string[];
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
 * Final response payload returned to the consumer.
 */
export interface AgenticRouterResponse {
	status: AgenticRouterStatus;
	model: string;
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
 * Agentic router responsible for planning tool calls and returning grounded summaries.
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
	 * Runs the planning loop, executes required tools, and returns the final summary.
	 *
	 * @param prompt Natural language input from the end user.
	 * @param systemInstruction Optional system-level directive passed to the planner and response phase.
	 */
	async runAndRespond(
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

		const summary = await this._resolveResponse(
			this._createResponseRequest(
				resolution.effectivePrompt,
				resolution.effectiveSystemInstruction,
				conversationHistory,
				resolution.toolResults,
			),
		);

		const response = {
			status: "completed" as const,
			model: this.options.model,
			prompt: resolution.effectivePrompt,
			systemInstruction: resolution.effectiveSystemInstruction,
			content: summary.content,
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
	 * Runs the full agentic loop and streams response deltas as they arrive.
	 *
	 * Planning and tool execution are completed before the response phase starts.
	 */
	async *runAndRespondStream(
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

		const responseRequest = this._createResponseRequest(
			resolution.effectivePrompt,
			resolution.effectiveSystemInstruction,
			conversationHistory,
			resolution.toolResults,
		);
		const resolvedResponse =
			await this.options.responseResolver?.(responseRequest);
		let content = "";

		if (resolvedResponse) {
			if (resolvedResponse.phase !== responseRequest.phase) {
				throw new Error(
					`Response resolver returned a ${resolvedResponse.phase} response for a ${responseRequest.phase} request.`,
				);
			}

			content = resolvedResponse.content;

			if (content) {
				yield {
					type: "response",
					delta: content,
					content,
				};
			}
		} else {
			for await (const chunk of this._streamResponse(responseRequest)) {
				content = chunk.content;

				if (!chunk.delta) {
					continue;
				}

				yield {
					type: "response",
					delta: chunk.delta,
					content: chunk.content,
				};
			}
		}

		const response: AgenticRouterResponse = {
			status: "completed",
			model: this.options.model,
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
		request: AgenticLLMResponseRequest,
	): Promise<AgenticLLMResponseResponse>;
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

	private _createResponseRequest(
		prompt: string,
		systemInstruction: string | undefined,
		conversationHistory: readonly AgenticConversationMessage[] | undefined,
		toolResults: readonly AgenticToolExecutionResult[],
	): AgenticLLMResponseRequest {
		return {
			phase: "respond",
			prompt,
			systemInstruction,
			conversationHistory,
			tools: this._getProviderTools(),
			toolResults,
		};
	}

	private async _resolveResponse(
		request: AgenticLLMResponseRequest,
	): Promise<AgenticLLMResponseResponse> {
		return (await this._resolveResponseWithSource(request)).response;
	}

	private async _resolveResponseWithSource(
		request: AgenticLLMResponseRequest,
	): Promise<{
		response: AgenticLLMResponseResponse;
		source: "resolver" | "provider";
	}> {
		const resolved = await this.options.responseResolver?.(request);

		if (resolved) {
			if (resolved.phase !== request.phase) {
				throw new Error(
					`Response resolver returned a ${resolved.phase} response for a ${request.phase} request.`,
				);
			}

			return {
				response: resolved,
				source: "resolver",
			};
		}

		return {
			response: await this._callLLM(request),
			source: "provider",
		};
	}

	/**
	 * Streams response chunks from the provider, or falls back to a single response.
	 */
	private async *_streamResponse(
		request: AgenticLLMResponseRequest,
	): AsyncGenerator<AgenticLLMResponseStreamChunk, void, void> {
		if (!this.options.useStreaming || !this.options.provider.stream) {
			const fallback = await this._callLLM(request);
			yield {
				phase: "respond",
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
				phase: "respond",
				delta: fallback.content,
				content: fallback.content,
			};
		}
	}

	/**
	 * Resolves planning and tool execution before the final response phase.
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
				conversationHistory: this.options.includeHistoryInPlanning
					? conversationHistory
					: undefined,
				tools: this._getProviderTools(),
				toolResults,
				maxToolCalls: 2,
			});

			if (planning.toolCalls.length === 0) {
				const guardedPause = await this._createMissingInputGuardrailResponse(
					effectivePrompt,
					effectiveSystemInstruction,
					runOptions,
					toolResults,
					iterations,
				);

				if (guardedPause) {
					return {
						status: "needs-user-input",
						historyUserPrompt,
						response: guardedPause,
					};
				}

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

				const mutationGuardrailPause =
					await this._createMutationGuardrailResponse(toolCall, {
						prompt: effectivePrompt,
						systemInstruction: effectiveSystemInstruction,
						conversationId: runOptions.conversationId,
						iteration: iterations,
						toolResults,
					});

				if (mutationGuardrailPause) {
					return {
						status: "needs-user-input",
						historyUserPrompt,
						response: mutationGuardrailPause,
					};
				}

				const execution = await this._tryExecutePlannedToolCall(toolCall, {
					prompt: effectivePrompt,
					systemInstruction: effectiveSystemInstruction,
					conversationId: runOptions.conversationId,
					iteration: iterations,
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

	private async _createMutationGuardrailResponse(
		plan: AgenticToolCallPlan,
		context: AgenticToolExecutionContext,
	): Promise<AgenticRouterResponse | undefined> {
		if (!this.options.enableInteractiveCorrections) {
			return undefined;
		}

		const definition = this.tools.get(plan.toolName);

		if (!definition || !this._isMutationTool(definition)) {
			return undefined;
		}

		const requiredFields = getRequiredToolFieldNames(definition.schema);

		if (requiredFields.length === 0) {
			return undefined;
		}

		const missingOrUnevidenced = requiredFields.filter((fieldName) => {
			const value = plan.arguments[fieldName];

			if (isGuardrailEmptyValue(value)) {
				return true;
			}

			return !this._hasPromptEvidenceForArgument(context.prompt, value);
		});

		if (missingOrUnevidenced.length === 0) {
			return undefined;
		}

		const guardedArguments = Object.fromEntries(
			Object.entries(plan.arguments).filter(([fieldName, value]) => {
				if (!requiredFields.includes(fieldName)) {
					return true;
				}

				if (isGuardrailEmptyValue(value)) {
					return false;
				}

				return this._hasPromptEvidenceForArgument(context.prompt, value);
			}),
		);

		const correctionFields: AgenticPendingCorrectionField[] =
			missingOrUnevidenced.map((fieldName) => {
				const valueType = extractCorrectionValueType(definition.schema, [
					fieldName,
				]);

				return {
					name: fieldName,
					message: `Provide an explicit value for ${fieldName}. The router will not assume required mutation inputs.`,
					...(valueType ? { valueType } : {}),
				};
			});

		const correction: AgenticPendingCorrection = {
			reason: "validation-required",
			message: `I need explicit required values before I can run ${plan.toolName}. Please provide: ${missingOrUnevidenced.join(", ")}.`,
			toolCall: {
				...plan,
				arguments: guardedArguments,
			},
			fields: correctionFields,
			originalPrompt: context.prompt,
			originalSystemInstruction: context.systemInstruction,
			iteration: context.iteration,
		};

		return this._buildPausedResponse(
			correction,
			context.toolResults,
			context.conversationId,
		);
	}

	private _isMutationTool(definition: AgenticToolDefinition): boolean {
		if (definition.options?.isMutation !== undefined) {
			return definition.options.isMutation;
		}

		const toolText =
			`${definition.name} ${definition.description}`.toLowerCase();

		return /\b(add|create|update|adjust|remove|delete|insert|modify|change|set)\b/.test(
			toolText,
		);
	}

	private _hasPromptEvidenceForArgument(
		prompt: string,
		value: unknown,
	): boolean {
		const promptText = prompt.trim().toLowerCase();

		if (!promptText) {
			return false;
		}

		if (typeof value === "string") {
			const normalizedValue = value.trim().toLowerCase();

			if (!normalizedValue) {
				return false;
			}

			return promptText.includes(normalizedValue);
		}

		if (typeof value === "number" || typeof value === "boolean") {
			return promptText.includes(String(value).toLowerCase());
		}

		if (Array.isArray(value)) {
			if (value.length === 0) {
				return false;
			}

			return value.every((entry) => {
				return this._hasPromptEvidenceForArgument(promptText, entry);
			});
		}

		return false;
	}

	private async _createMissingInputGuardrailResponse(
		prompt: string,
		systemInstruction: string | undefined,
		runOptions: AgenticRunOptions,
		toolResults: readonly AgenticToolExecutionResult[],
		iteration: number,
	): Promise<AgenticRouterResponse | undefined> {
		if (!this.options.enableInteractiveCorrections) {
			return undefined;
		}

		if (toolResults.length > 0) {
			return undefined;
		}

		if (runOptions.correctionAnswer) {
			return undefined;
		}

		const likelyTool = this._findLikelyToolForPrompt(prompt);

		if (!likelyTool) {
			return undefined;
		}

		const validation = await likelyTool.schema.safeParseAsync({});

		if (validation.success) {
			return undefined;
		}

		const correction = this._createValidationCorrection(
			{
				toolName: likelyTool.name,
				rationale:
					"Guardrail fallback: tool likely required but missing required arguments.",
				arguments: {},
			},
			{
				prompt,
				systemInstruction,
				conversationId: runOptions.conversationId,
				iteration,
				toolResults,
			},
			likelyTool.schema,
			validation.error,
		);

		if (correction.fields.length === 0) {
			return undefined;
		}

		return this._buildPausedResponse(
			correction,
			toolResults,
			runOptions.conversationId,
		);
	}

	private _findLikelyToolForPrompt(
		prompt: string,
	): AgenticToolDefinition | undefined {
		const promptText = normalizeIntentText(prompt);
		const promptTokens = new Set(this._tokenizePrompt(promptText));
		const hasMutationIntent = this._hasMutationIntent(promptText);

		const ranked = [...this.tools.values()]
			.map((tool) => {
				const toolText = normalizeIntentText(
					`${tool.name} ${tool.description}`,
				);
				const toolTokens = new Set(this._tokenizePrompt(toolText));
				let score = promptText.includes(normalizeIntentText(tool.name)) ? 8 : 0;
				const isMutationTool = this._isMutationTool(tool);
				const hasIntentKeywordMatch = this._toolHasIntentKeywordMatch(
					promptText,
					tool,
				);

				for (const token of toolTokens) {
					if (promptTokens.has(token)) {
						score += 1;
					}
				}

				if (hasIntentKeywordMatch) {
					score += 4;
				}

				if (hasMutationIntent && isMutationTool) {
					score += 3;
				}

				return { tool, score };
			})
			.sort((left, right) => right.score - left.score);

		const minScore = hasMutationIntent ? 1 : 2;

		if (!ranked[0] || ranked[0].score < minScore) {
			return undefined;
		}

		return ranked[0].tool;
	}

	private _hasMutationIntent(prompt: string): boolean {
		const normalizedPrompt = normalizeIntentText(prompt);

		if (
			/\b(create|add|update|adjust|remove|delete|insert|modify|change|set|hire)\b/.test(
				normalizedPrompt,
			)
		) {
			return true;
		}

		return [...this.tools.values()].some((tool) => {
			return (
				this._isMutationTool(tool) &&
				this._toolHasIntentKeywordMatch(normalizedPrompt, tool)
			);
		});
	}

	private _toolHasIntentKeywordMatch(
		prompt: string,
		tool: AgenticToolDefinition,
	): boolean {
		const normalizedPrompt = normalizeIntentText(prompt);

		return (tool.options?.intentKeywords ?? []).some((keyword) => {
			const normalizedKeyword = normalizeIntentText(keyword);

			return normalizedKeyword.length > 0
				? normalizedPrompt.includes(normalizedKeyword)
				: false;
		});
	}

	private _tokenizePrompt(value: string): string[] {
		const tokens = normalizeIntentText(value).match(/[\p{L}\p{N}]+/gu) ?? [];

		return [...new Set(tokens.filter((token) => token.length > 1))];
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
			return "Delivered a final summary without calling any tool.";
		}

		return [
			"Delivered a final summary using the following tool results:",
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
		_conversationId?: string,
	): AgenticRouterResponse {
		return {
			status: "needs-user-input",
			model: this.options.model,
			prompt: pendingCorrection.originalPrompt,
			systemInstruction: pendingCorrection.originalSystemInstruction,
			content: this._renderPausedResponseContent(pendingCorrection),
			toolCalls: [...toolCalls],
			iterations: pendingCorrection.iteration,
			pendingCorrection,
		};
	}

	private _renderPausedResponseContent(
		pendingCorrection: AgenticPendingCorrection,
	): string {
		return [
			"Additional input required.",
			pendingCorrection.message,
			...pendingCorrection.fields.map((field) => {
				return `${field.name}: ${field.message}`;
			}),
		].join("\n");
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

function getRequiredToolFieldNames(schema: ZodTypeAny): string[] {
	const baseSchema = unwrapCorrectionSchema(schema);

	if (!(baseSchema instanceof z.ZodObject)) {
		return [];
	}

	const shape = baseSchema.shape as Record<string, ZodTypeAny>;

	return Object.entries(shape)
		.filter(([, fieldSchema]) => !isOptionalToolFieldSchema(fieldSchema))
		.map(([fieldName]) => fieldName);
}

function isOptionalToolFieldSchema(schema: ZodTypeAny): boolean {
	const candidate = schema as ZodTypeAny & {
		isOptional?: () => boolean;
		removeDefault?: () => ZodTypeAny;
		unwrap?: () => ZodTypeAny;
	};

	if (typeof candidate.isOptional === "function" && candidate.isOptional()) {
		return true;
	}

	if (typeof candidate.removeDefault === "function") {
		return isOptionalToolFieldSchema(candidate.removeDefault());
	}

	if (typeof candidate.unwrap === "function") {
		return isOptionalToolFieldSchema(candidate.unwrap());
	}

	return false;
}

function isGuardrailEmptyValue(value: unknown): boolean {
	if (value === undefined || value === null) {
		return true;
	}

	if (typeof value === "string") {
		return value.trim().length === 0;
	}

	if (Array.isArray(value)) {
		return value.length === 0;
	}

	return false;
}

function normalizeIntentText(value: string): string {
	return value.toLowerCase().normalize("NFKC");
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
				phase: "respond",
				content: buildSummaryResponse(
					request.prompt,
					request.systemInstruction,
					request.toolResults,
				),
			};
		},
		stream: async function* (
			request: AgenticLLMResponseRequest,
		): AsyncGenerator<AgenticLLMResponseStreamChunk, void, void> {
			const content = buildSummaryResponse(
				request.prompt,
				request.systemInstruction,
				request.toolResults,
			);

			yield {
				phase: "respond",
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
 * Builds a grounded plain-text summary from executed tool results.
 */
function buildSummaryResponse(
	prompt: string,
	systemInstruction: string | undefined,
	toolResults: readonly AgenticToolExecutionResult[],
): string {
	const lines = [
		`Prompt: ${prompt}`,
		`System instruction: ${systemInstruction ?? "none"}`,
	];

	if (toolResults.length === 0) {
		lines.push("No tool call was required for this prompt.");
		return lines.join("\n");
	}

	lines.push(`Completed ${toolResults.length} tool call(s).`);
	lines.push("Actions and retrieved data:");

	for (const [index, result] of toolResults.entries()) {
		lines.push(
			`${index + 1}. ${result.toolName} (${result.durationMs} ms): ${summarizeToolResult(result.result)}`,
		);
	}

	return lines.join("\n");
}

function summarizeToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	const json = JSON.stringify(result);
	if (!json) {
		return "No result returned.";
	}

	return json.length <= 240 ? json : `${json.slice(0, 237)}...`;
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
