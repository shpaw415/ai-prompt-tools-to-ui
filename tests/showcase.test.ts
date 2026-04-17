import { describe, expect, it } from "bun:test";
import type { AgenticLLMRenderRequest } from "../index";
import {
	DEFAULT_SHOWCASE_TEMPLATE_EMPLOYEE_THRESHOLD,
	createShowcaseRenderResolver,
} from "../showcase/setup";

describe("showcase render resolver", () => {
	it("falls back to the LLM for small list-only responses", async () => {
		const resolver = createShowcaseRenderResolver({
			employeeCountThreshold: 5,
		});

		const response = await resolver(
			createRenderRequest({
				toolResults: [
					createToolResult("list_employees", {
						employees: [createEmployee("Alicia"), createEmployee("Karim")],
						summary: createSummary(2),
					}),
				],
			}),
		);

		expect(response).toBeUndefined();
	});

	it("renders deterministic showcase HTML for large employee lists", async () => {
		const resolver = createShowcaseRenderResolver({
			employeeCountThreshold: 3,
		});

		const response = await resolver(
			createRenderRequest({
				prompt: "Show the employee roster",
				toolResults: [
					createToolResult("list_employees", {
						employees: [
							createEmployee("Alicia"),
							createEmployee("Karim"),
							createEmployee("Mina"),
						],
						summary: createSummary(3),
					}),
				],
			}),
		);

		expect(response?.phase).toBe("render");
		expect(response?.content).toContain("HR dashboard");
		expect(response?.content).toContain("Employee roster");
		expect(response?.content).toContain("Alicia");
		expect(response?.content).toContain("Karim");
		expect(response?.content).toContain("Mina");
	});

	it("renders deterministic showcase HTML for mutation-plus-list flows even below the threshold", async () => {
		const resolver = createShowcaseRenderResolver({
			employeeCountThreshold: DEFAULT_SHOWCASE_TEMPLATE_EMPLOYEE_THRESHOLD,
		});

		const response = await resolver(
			createRenderRequest({
				prompt: "Add Priya and show the payroll impact",
				toolResults: [
					createToolResult("add_employee", {
						action: "employee_added",
						employee: createEmployee("Priya", "Data Engineer", "Analytics"),
					}),
					createToolResult("list_employees", {
						employees: [
							createEmployee("Alicia"),
							createEmployee("Priya", "Data Engineer", "Analytics"),
						],
						summary: createSummary(2),
					}),
				],
			}),
		);

		expect(response?.content).toContain("Recent actions");
		expect(response?.content).toContain("Added Priya to Analytics.");
		expect(response?.content).toContain("Priya");
	});

	it("escapes hostile employee data in showcase HTML", async () => {
		const resolver = createShowcaseRenderResolver({
			employeeCountThreshold: 1,
		});

		const response = await resolver(
			createRenderRequest({
				prompt: "Show the roster <script>",
				toolResults: [
					createToolResult("list_employees", {
						employees: [
							createEmployee("<img src=x onerror=alert(1)>", "<b>Engineer</b>"),
						],
						summary: createSummary(1),
					}),
				],
			}),
		);

		expect(response?.content).toContain("&lt;script&gt;");
		expect(response?.content).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(response?.content).toContain("&lt;b&gt;Engineer&lt;/b&gt;");
		expect(response?.content).not.toContain("<script>");
		expect(response?.content).not.toContain("<img src=x onerror=alert(1)>");
	});
});

function createRenderRequest(
	input: Partial<AgenticLLMRenderRequest> & {
		toolResults: AgenticLLMRenderRequest["toolResults"];
	},
): AgenticLLMRenderRequest {
	return {
		phase: "render",
		prompt: input.prompt ?? "Show the roster",
		outputFormat: input.outputFormat ?? "html",
		tools: input.tools ?? [],
		toolResults: input.toolResults,
		conversationHistory: input.conversationHistory,
		renderStyle: input.renderStyle,
		renderStyleInstruction: input.renderStyleInstruction,
		systemInstruction: input.systemInstruction,
	};
}

function createToolResult(toolName: string, result: unknown) {
	return {
		toolName,
		rationale: `${toolName} was required.`,
		arguments: {},
		result,
		durationMs: 1,
	};
}

function createEmployee(
	name: string,
	role = "Engineer",
	department = "Platform",
) {
	return {
		name,
		role,
		department,
		salary: 72000,
	};
}

function createSummary(headcount: number) {
	return {
		headcount,
		totalPayroll: headcount * 72000,
		averageSalary: 72000,
		highestSalary: {
			name: "Alicia",
			salary: 72000,
		},
	};
}
