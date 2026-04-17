import type {
	AgenticConversationHistoryProvider,
	AgenticConversationMessage,
} from "../index";

export interface InMemoryHistoryProviderOptions {
	initialConversations?: Record<string, readonly AgenticConversationMessage[]>;
}

/**
 * Creates an in-memory conversation history provider.
 *
 * This is useful for demos, tests, and short-lived processes where persistence
 * across restarts is not required.
 */
export function createInMemoryHistoryProvider(
	options: InMemoryHistoryProviderOptions = {},
): AgenticConversationHistoryProvider {
	const store = new Map<string, AgenticConversationMessage[]>(
		Object.entries(options.initialConversations ?? {}).map(
			([conversationId, messages]) => {
				return [conversationId, [...messages]];
			},
		),
	);

	return {
		name: "in-memory-history-provider",
		get(conversationId) {
			return [...(store.get(conversationId) ?? [])];
		},
		set(conversationId, messages) {
			store.set(conversationId, [...messages]);
		},
		delete(conversationId) {
			store.delete(conversationId);
		},
	};
}
