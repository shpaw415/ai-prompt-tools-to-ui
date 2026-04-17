import { Database } from "bun:sqlite";
import {
	AgenticRouter,
	createBunSQLiteHistoryProvider,
	createGitHubCopilotProvider,
	createGeminiProvider,
	createMockLLMProvider,
	z,
} from "../";

type EmployeeRow = {
	id: number;
	name: string;
	role: string;
	department: string | null;
	salaryCents: number;
	createdAt: string;
	updatedAt: string;
};

export const SHOWCASE_DEFAULT_CONVERSATION_ID = "hr-showcase-default";
export const SHOWCASE_DEFAULT_PROMPT =
	"Show the employee roster and summarize the current payroll.";
export const SHOWCASE_SYSTEM_INSTRUCTION =
	"You are a senior HR operations assistant for a Bun SQLite showcase. For every request about employees, payroll, or roster changes, you must use the available HR tools before answering. Never invent employee rows, salaries, totals, or placeholder values. For read-only requests, call list_employees before summarizing. For add, remove, or salary updates, call the relevant mutation tool and then call list_employees again before producing the final answer. If a required field is missing or an action is destructive, rely on the tool correction or confirmation flow instead of guessing. Return clean HTML grounded only in tool results.";
export const SHOWCASE_SAMPLE_PROMPTS = [
	"Show the employee roster and summarize the current payroll.",
	"Add Priya Nair as a Staff Data Engineer in Analytics at 98000 and show the payroll impact.",
	"Increase Karim Diallo salary by 3500 and explain the delta versus the team average.",
	"Remove Mina Rossi and summarize the payroll impact.",
];

export interface ShowcaseOverview {
	conversationId: string;
	defaultPrompt: string;
	providerMode: "github-models" | "mock";
	providerLabel: string;
	samplePrompts: readonly string[];
	summary: {
		headcount: number;
		totalPayroll: number;
		averageSalary: number;
		highestSalary?: { name: string; salary: number };
	};
	employees: Array<Record<string, unknown>>;
	departments: string[];
}

export interface ShowcaseRuntime {
	database: Database;
	historyProvider: ReturnType<typeof createBunSQLiteHistoryProvider>;
	router: AgenticRouter;
	providerMode: "github-models" | "mock";
	providerLabel: string;
	getOverview(): ShowcaseOverview;
}

export interface ShowcaseRuntimeOptions {
	databasePath?: string;
	providerApiKey?: string;
	providerModel?: string;
	defaultConversationId?: string;
}

export function createShowcaseRuntime(
	options: ShowcaseRuntimeOptions = {},
): ShowcaseRuntime {
	const database = new Database(
		options.databasePath ?? `${import.meta.dir}/employees.sqlite`,
		{ create: true },
	);
	const historyProvider = createBunSQLiteHistoryProvider({
		database,
	});
	initializeDatabase(database);

	const apiKey =
		options.providerApiKey?.trim() ?? process.env.GITHUB_TOKEN?.trim();

	const provider = createGeminiProvider({
		apiKey: process.env.GEMINI_API_KEY?.trim() as string,
		model: "gemini-2.5-flash",
	});
	/*
	apiKey
		? createGitHubCopilotProvider({
				apiKey,
				model: options.providerModel ?? "openai/gpt-4.1",
			})
		: createMockLLMProvider({
				model: "mock-showcase-web-ui",
			});
	*/
	const providerMode = apiKey ? "github-models" : "mock";
	const providerLabel = apiKey
		? `GitHub Models (${options.providerModel ?? "openai/gpt-4.1"})`
		: "Mock provider";

	if (!apiKey) {
		console.warn(
			"[showcase] GITHUB_TOKEN is not set. Falling back to the mock provider for the Web UI showcase.",
		);
	}

	const router = new AgenticRouter({
		useStreaming: true,
		enableInteractiveCorrections: true,
		outputFormat: "html",
		renderStyle: "inline-css",
		renderStyleInstruction:
			"Return a polished HR dashboard with clean cards, salary highlights, compact tables, and clear action summaries.",
		historyProvider,
		provider,
	});

	registerShowcaseTools(router, database);

	return {
		database,
		historyProvider,
		router,
		providerMode,
		providerLabel,
		getOverview() {
			const employees = getEmployees(database);
			const departments = [
				...new Set(
					employees
						.map((employee) => employee.department)
						.filter((department): department is string => Boolean(department)),
				),
			].sort((left, right) => left.localeCompare(right));

			return {
				conversationId:
					options.defaultConversationId ?? SHOWCASE_DEFAULT_CONVERSATION_ID,
				defaultPrompt: SHOWCASE_DEFAULT_PROMPT,
				providerMode,
				providerLabel,
				samplePrompts: SHOWCASE_SAMPLE_PROMPTS,
				summary: buildPayrollSummary(employees),
				employees: employees.map(serializeEmployee),
				departments,
			};
		},
	};
}

function registerShowcaseTools(
	router: AgenticRouter,
	database: Database,
): void {
	router.registerTool(
		"list_employees",
		"List employees from the Bun SQLite HR database with their roles, departments, and salaries.",
		z.object({
			department: z.string().optional(),
			sortBy: z.enum(["salary", "name", "recent"]).optional(),
		}),
		({ department, sortBy }) => {
			const rows = getEmployees(database, {
				department,
				sortBy: sortBy ?? "salary",
			});

			return {
				employees: rows.map(serializeEmployee),
				summary: buildPayrollSummary(rows),
			};
		},
	);

	router.registerTool(
		"add_employee",
		"Add a new employee to the Bun SQLite HR database.",
		z.object({
			name: z.string().min(2),
			role: z.enum(["admin", "employee"]),
			department: z
				.enum(["Product Engineering", "Platform", "Design"])
				.optional(),
			salary: z.number().positive(),
		}),
		({ name, role, department, salary }) => {
			const existingEmployee = findEmployeeByName(database, name);

			if (existingEmployee) {
				throw new Error(`Employee "${name}" already exists.`);
			}

			const employee = insertEmployee(database, {
				name,
				role,
				department: department ?? null,
				salary,
			});

			return {
				action: "employee_added",
				employee: serializeEmployee(employee),
				summary: buildPayrollSummary(getEmployees(database)),
			};
		},
	);

	router.registerTool(
		"remove_employee",
		"Remove an employee from the Bun SQLite HR database by exact name.",
		z.object({
			name: z.string().min(2),
		}),
		({ name }) => {
			const employee = requireEmployeeByName(database, name);
			database.query("DELETE FROM employees WHERE id = ?").run(employee.id);

			return {
				action: "employee_removed",
				employee: serializeEmployee(employee),
				summary: buildPayrollSummary(getEmployees(database)),
			};
		},
		{
			requiresConfirmation: true,
			confirmationKey: "remove-employee",
			confirmationMessage:
				"Please confirm that you want to remove this employee from the HR database.",
		},
	);

	router.registerTool(
		"adjust_employee_salary",
		"Adjust an employee salary by exact name using either a delta amount or a new salary.",
		z.object({
			name: z.string().min(2),
			amount: z.number().optional(),
			newSalary: z.number().positive().optional(),
			reason: z.string().optional(),
		}),
		({ name, amount, newSalary, reason }) => {
			if (amount === undefined && newSalary === undefined) {
				throw new Error("Provide either an amount delta or a newSalary value.");
			}

			const employee = requireEmployeeByName(database, name);
			const nextSalaryCents =
				newSalary !== undefined
					? toSalaryCents(newSalary)
					: employee.salaryCents + toSalaryCents(amount ?? 0);

			if (nextSalaryCents < 0) {
				throw new Error("Resulting salary cannot be negative.");
			}

			database
				.query(
					"UPDATE employees SET salary_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
				)
				.run(nextSalaryCents, employee.id);

			const updatedEmployee = requireEmployeeByName(database, name);

			return {
				action: "salary_adjusted",
				reason: reason ?? "No reason provided.",
				before: serializeEmployee(employee),
				after: serializeEmployee(updatedEmployee),
				summary: buildPayrollSummary(getEmployees(database)),
			};
		},
	);
}

function initializeDatabase(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS employees (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL,
			department TEXT,
			salary_cents INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`);

	const row = db.query("SELECT COUNT(*) AS count FROM employees").get() as {
		count: number;
	};

	if (row.count > 0) {
		return;
	}

	for (const employee of [
		{
			name: "Alicia Bernard",
			role: "Frontend Engineer",
			department: "Product Engineering",
			salary: 72000,
		},
		{
			name: "Karim Diallo",
			role: "DevOps Engineer",
			department: "Platform",
			salary: 84500,
		},
		{
			name: "Mina Rossi",
			role: "Product Designer",
			department: "Design",
			salary: 68500,
		},
	]) {
		insertEmployee(db, employee);
	}
}

function getEmployees(
	db: Database,
	options: {
		department?: string;
		sortBy?: "salary" | "name" | "recent";
	} = {},
): EmployeeRow[] {
	const sortColumn =
		options.sortBy === "name"
			? "name COLLATE NOCASE ASC"
			: options.sortBy === "recent"
				? "updated_at DESC, name COLLATE NOCASE ASC"
				: "salary_cents DESC, name COLLATE NOCASE ASC";

	if (options.department) {
		return db
			.query(
				`SELECT id, name, role, department, salary_cents AS salaryCents, created_at AS createdAt, updated_at AS updatedAt
				 FROM employees
				 WHERE lower(coalesce(department, '')) = lower(?)
				 ORDER BY ${sortColumn}`,
			)
			.all(options.department) as EmployeeRow[];
	}

	return db
		.query(
			`SELECT id, name, role, department, salary_cents AS salaryCents, created_at AS createdAt, updated_at AS updatedAt
			 FROM employees
			 ORDER BY ${sortColumn}`,
		)
		.all() as EmployeeRow[];
}

function findEmployeeByName(db: Database, name: string): EmployeeRow | null {
	return db
		.query(
			"SELECT id, name, role, department, salary_cents AS salaryCents, created_at AS createdAt, updated_at AS updatedAt FROM employees WHERE lower(name) = lower(?) LIMIT 1",
		)
		.get(name) as EmployeeRow | null;
}

function requireEmployeeByName(db: Database, name: string): EmployeeRow {
	const employee = findEmployeeByName(db, name);

	if (!employee) {
		throw new Error(`Employee "${name}" was not found.`);
	}

	return employee;
}

function insertEmployee(
	db: Database,
	input: {
		name: string;
		role: string;
		department: string | null;
		salary: number;
	},
): EmployeeRow {
	db.query(
		"INSERT INTO employees (name, role, department, salary_cents) VALUES (?, ?, ?, ?)",
	).run(input.name, input.role, input.department, toSalaryCents(input.salary));

	return requireEmployeeByName(db, input.name);
}

function buildPayrollSummary(rows: EmployeeRow[]): {
	headcount: number;
	totalPayroll: number;
	averageSalary: number;
	highestSalary?: { name: string; salary: number };
} {
	const totalPayroll = rows.reduce((sum, row) => sum + row.salaryCents, 0);
	const averageSalary = rows.length === 0 ? 0 : totalPayroll / rows.length;
	const highestRow = rows.reduce<EmployeeRow | undefined>((highest, row) => {
		if (!highest || row.salaryCents > highest.salaryCents) {
			return row;
		}

		return highest;
	}, undefined);

	return {
		headcount: rows.length,
		totalPayroll: fromSalaryCents(totalPayroll),
		averageSalary: Number(fromSalaryCents(averageSalary).toFixed(2)),
		highestSalary: highestRow
			? {
					name: highestRow.name,
					salary: fromSalaryCents(highestRow.salaryCents),
				}
			: undefined,
	};
}

function serializeEmployee(row: EmployeeRow): Record<string, unknown> {
	return {
		id: row.id,
		name: row.name,
		role: row.role,
		department: row.department,
		salary: fromSalaryCents(row.salaryCents),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toSalaryCents(value: number): number {
	return Math.round(value * 100);
}

function fromSalaryCents(value: number): number {
	return Number((value / 100).toFixed(2));
}
