import { describe, expect, it } from "bun:test";
import {
	SHOWCASE_DEFAULT_PROMPT,
	SHOWCASE_SYSTEM_INSTRUCTION,
	createShowcaseRuntime,
} from "../showcase/setup";

describe("showcase runtime", () => {
	it("returns overview data from the Bun SQLite showcase", () => {
		const runtime = createShowcaseRuntime({ databasePath: ":memory:" });
		const overview = runtime.getOverview();

		expect(overview.defaultPrompt).toBe(SHOWCASE_DEFAULT_PROMPT);
		expect(overview.summary.headcount).toBeGreaterThan(0);
		expect(overview.employees.length).toBeGreaterThan(0);
		expect(overview.departments.length).toBeGreaterThan(0);
	});

	it("uses a plain-text summary system instruction instead of HTML rendering guidance", () => {
		expect(SHOWCASE_SYSTEM_INSTRUCTION).toContain("plain-text summary");
		expect(SHOWCASE_SYSTEM_INSTRUCTION).not.toContain("Return clean HTML");
	});
});
