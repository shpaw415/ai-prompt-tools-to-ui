import type { AgenticConversationHistoryProvider } from "../index";
import {
	ensureSafeSqlIdentifier,
	parseConversationMessages,
	serializeConversationMessages,
} from "./shared";

export interface CloudflareD1Result<T = Record<string, unknown>> {
	results?: T[];
	success?: boolean;
	meta?: Record<string, unknown>;
}

export interface CloudflareD1PreparedStatement {
	bind(...values: unknown[]): CloudflareD1PreparedStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<CloudflareD1Result>;
}

export interface CloudflareD1Database {
	prepare(query: string): CloudflareD1PreparedStatement;
	exec?(query: string): Promise<unknown>;
}

export interface CloudflareD1HistoryProviderOptions {
	database: CloudflareD1Database;
	tableName?: string;
	initializeSchema?: boolean;
}

/**
 * Creates a Cloudflare D1-backed conversation history provider.
 */
export function createCloudflareD1HistoryProvider(
	options: CloudflareD1HistoryProviderOptions,
): AgenticConversationHistoryProvider {
	const tableName = ensureSafeSqlIdentifier(
		options.tableName ?? "conversation_history",
		"Cloudflare D1 history table name",
	);
	const schemaStatement = `
		CREATE TABLE IF NOT EXISTS ${tableName} (
			conversation_id TEXT PRIMARY KEY,
			messages_json TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`;
	let schemaReadyPromise: Promise<void> | undefined;

	const ensureSchema = async (): Promise<void> => {
		if ((options.initializeSchema ?? true) === false) {
			return;
		}

		if (!schemaReadyPromise) {
			schemaReadyPromise = (async () => {
				if (options.database.exec) {
					await options.database.exec(schemaStatement);
					return;
				}

				await options.database.prepare(schemaStatement).run();
			})();
		}

		await schemaReadyPromise;
	};

	return {
		name: "cloudflare-d1-history-provider",
		async get(conversationId) {
			await ensureSchema();

			const row = await options.database
				.prepare(
					`SELECT messages_json AS messagesJson FROM ${tableName} WHERE conversation_id = ? LIMIT 1`,
				)
				.bind(conversationId)
				.first<{ messagesJson?: string }>();

			return parseConversationMessages(row?.messagesJson);
		},
		async set(conversationId, messages) {
			await ensureSchema();

			await options.database
				.prepare(
					`INSERT INTO ${tableName} (conversation_id, messages_json, updated_at)
					 VALUES (?, ?, CURRENT_TIMESTAMP)
					 ON CONFLICT(conversation_id)
					 DO UPDATE SET messages_json = excluded.messages_json, updated_at = CURRENT_TIMESTAMP`,
				)
				.bind(conversationId, serializeConversationMessages(messages))
				.run();
		},
		async delete(conversationId) {
			await ensureSchema();

			await options.database
				.prepare(`DELETE FROM ${tableName} WHERE conversation_id = ?`)
				.bind(conversationId)
				.run();
		},
	};
}
