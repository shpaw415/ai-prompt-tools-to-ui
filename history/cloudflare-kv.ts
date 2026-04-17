import type { AgenticConversationHistoryProvider } from "../index";
import {
	parseConversationMessages,
	serializeConversationMessages,
} from "./shared";

export interface CloudflareKVNamespace {
	get(key: string, type: "text"): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface CloudflareKVHistoryProviderOptions {
	namespace: CloudflareKVNamespace;
	keyPrefix?: string;
	expirationTtl?: number;
}

/**
 * Creates a Cloudflare KV-backed conversation history provider.
 */
export function createCloudflareKVHistoryProvider(
	options: CloudflareKVHistoryProviderOptions,
): AgenticConversationHistoryProvider {
	const keyPrefix = options.keyPrefix ?? "agentic-history:";

	return {
		name: "cloudflare-kv-history-provider",
		async get(conversationId) {
			const value = await options.namespace.get(
				`${keyPrefix}${conversationId}`,
				"text",
			);

			return parseConversationMessages(value);
		},
		async set(conversationId, messages) {
			await options.namespace.put(
				`${keyPrefix}${conversationId}`,
				serializeConversationMessages(messages),
				options.expirationTtl
					? { expirationTtl: options.expirationTtl }
					: undefined,
			);
		},
		async delete(conversationId) {
			await options.namespace.delete(`${keyPrefix}${conversationId}`);
		},
	};
}
