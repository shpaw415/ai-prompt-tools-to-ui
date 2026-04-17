import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	createBunSQLiteHistoryProvider,
	createCloudflareD1HistoryProvider,
	createCloudflareKVHistoryProvider,
	type CloudflareD1Database,
	type CloudflareD1PreparedStatement,
	type CloudflareKVNamespace,
} from "../index";

describe("conversation history providers", () => {
	/**
	 * Covers the Bun SQLite history provider contract.
	 *
	 * This is useful because the Bun-native SQLite implementation is the most
	 * direct persistence option for local demos and Bun servers.
	 */
	it("persists conversation history in Bun SQLite", async () => {
		const database = new Database(":memory:");
		const provider = createBunSQLiteHistoryProvider({ database });
		const messages = [
			{ role: "user" as const, content: "show the roster" },
			{ role: "assistant" as const, content: "Rendered the roster." },
		];

		await provider.set("demo-thread", messages);

		expect(await provider.get("demo-thread")).toEqual(messages);

		await provider.delete?.("demo-thread");

		expect(await provider.get("demo-thread")).toEqual([]);
	});

	/**
	 * Covers the Cloudflare D1 history provider contract.
	 *
	 * This is useful because D1 persistence needs to work with prepared statement
	 * semantics rather than Bun's synchronous SQLite API.
	 */
	it("persists conversation history in Cloudflare D1", async () => {
		const store = new Map<string, string>();
		let schemaExecutions = 0;
		const database = createD1Stub({
			onExecSchema() {
				schemaExecutions += 1;
			},
			store,
		});
		const provider = createCloudflareD1HistoryProvider({ database });
		const messages = [
			{ role: "user" as const, content: "show payroll summary" },
			{ role: "assistant" as const, content: "Rendered the summary." },
		];

		await provider.set("d1-thread", messages);

		expect(await provider.get("d1-thread")).toEqual(messages);
		expect(schemaExecutions).toBe(1);

		await provider.delete?.("d1-thread");

		expect(await provider.get("d1-thread")).toEqual([]);
	});

	/**
	 * Covers the Cloudflare KV history provider contract.
	 *
	 * This is useful because KV stores opaque values rather than relational rows,
	 * so the provider must correctly serialize and recover message arrays.
	 */
	it("persists conversation history in Cloudflare KV", async () => {
		const store = new Map<string, string>();
		const namespace: CloudflareKVNamespace = {
			async get(key) {
				return store.get(key) ?? null;
			},
			async put(key, value) {
				store.set(key, value);
			},
			async delete(key) {
				store.delete(key);
			},
		};
		const provider = createCloudflareKVHistoryProvider({
			namespace,
			keyPrefix: "history:",
		});
		const messages = [
			{ role: "user" as const, content: "show recent adjustments" },
			{ role: "assistant" as const, content: "Listed recent adjustments." },
		];

		await provider.set("kv-thread", messages);

		expect(await provider.get("kv-thread")).toEqual(messages);
		expect(store.has("history:kv-thread")).toBe(true);

		await provider.delete?.("kv-thread");

		expect(await provider.get("kv-thread")).toEqual([]);
	});
});

function createD1Stub(options: {
	store: Map<string, string>;
	onExecSchema: () => void;
}): CloudflareD1Database {
	return {
		exec: async () => {
			options.onExecSchema();
		},
		prepare(query: string): CloudflareD1PreparedStatement {
			let values: unknown[] = [];

			return {
				bind(...boundValues: unknown[]) {
					values = boundValues;
					return this;
				},
				async first<T>() {
					if (query.includes("SELECT messages_json")) {
						const conversationId = String(values[0] ?? "");
						const messagesJson = options.store.get(conversationId);

						return (messagesJson ? ({ messagesJson } as T) : null) as T | null;
					}

					return null;
				},
				async run() {
					if (query.includes("INSERT INTO")) {
						options.store.set(
							String(values[0] ?? ""),
							String(values[1] ?? "[]"),
						);
					}

					if (query.includes("DELETE FROM")) {
						options.store.delete(String(values[0] ?? ""));
					}

					return { success: true, results: [] };
				},
			};
		},
	};
}
