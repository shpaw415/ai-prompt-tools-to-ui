import type { AgenticConversationMessage } from "../index";

export function serializeConversationMessages(
	messages: readonly AgenticConversationMessage[],
): string {
	return JSON.stringify(messages);
}

export function parseConversationMessages(
	value: string | null | undefined,
): AgenticConversationMessage[] {
	if (!value) {
		return [];
	}

	const parsed = JSON.parse(value) as unknown;

	if (!Array.isArray(parsed)) {
		throw new Error("Stored conversation history must be an array.");
	}

	return parsed
		.filter((entry) => {
			return (
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as { role?: unknown }).role === "string" &&
				typeof (entry as { content?: unknown }).content === "string"
			);
		})
		.map((entry) => {
			const candidate = entry as AgenticConversationMessage;

			return {
				role: candidate.role,
				content: candidate.content,
				timestamp: candidate.timestamp,
				metadata: candidate.metadata,
			};
		});
}

export function ensureSafeSqlIdentifier(value: string, label: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(`${label} must be a valid SQL identifier.`);
	}

	return value;
}
