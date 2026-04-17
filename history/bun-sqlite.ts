import type { Database } from "bun:sqlite";
import type {
	AgenticConversationHistoryProvider,
	AgenticConversationMessage,
} from "../index";
import {
	ensureSafeSqlIdentifier,
	parseConversationMessages,
	serializeConversationMessages,
} from "./shared";

export interface BunSQLiteHistoryProviderOptions {
	database: Database;
	tableName?: string;
	initializeSchema?: boolean;
}

/**
 * Creates a Bun SQLite-backed conversation history provider.
 */
export function createBunSQLiteHistoryProvider(
	options: BunSQLiteHistoryProviderOptions,
): AgenticConversationHistoryProvider {
	const tableName = ensureSafeSqlIdentifier(
		options.tableName ?? "conversation_history",
		"Bun SQLite history table name",
	);

	if (options.initializeSchema ?? true) {
		options.database.exec(`
			CREATE TABLE IF NOT EXISTS ${tableName} (
				conversation_id TEXT PRIMARY KEY,
				messages_json TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
		`);
	}

	return {
		name: "bun-sqlite-history-provider",
		get(conversationId) {
			const row = options.database
				.query(
					`SELECT messages_json AS messagesJson FROM ${tableName} WHERE conversation_id = ? LIMIT 1`,
				)
				.get(conversationId) as { messagesJson?: string } | null;

			return parseConversationMessages(row?.messagesJson);
		},
		set(conversationId, messages) {
			options.database
				.query(
					`INSERT INTO ${tableName} (conversation_id, messages_json, updated_at)
					 VALUES (?, ?, CURRENT_TIMESTAMP)
					 ON CONFLICT(conversation_id)
					 DO UPDATE SET messages_json = excluded.messages_json, updated_at = CURRENT_TIMESTAMP`,
				)
				.run(conversationId, serializeConversationMessages(messages));
		},
		delete(conversationId) {
			options.database
				.query(`DELETE FROM ${tableName} WHERE conversation_id = ?`)
				.run(conversationId);
		},
	};
}

export type BunSQLiteHistoryConversation = AgenticConversationMessage;
