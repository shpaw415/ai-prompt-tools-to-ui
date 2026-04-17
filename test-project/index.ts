import { Database } from "bun:sqlite";
import { AgenticRouter, createGitHubCopilotProvider, z } from "../";

type EmployeeRow = {
	id: number;
	name: string;
	role: string;
	department: string | null;
	salaryCents: number;
	createdAt: string;
	updatedAt: string;
};

const database = new Database(`${import.meta.dir}/employees.sqlite`, {
	create: true,
});

initializeDatabase(database);

const router = new AgenticRouter({
	useStreaming: true,
	outputFormat: "html",
	renderStyle: "inline-css",
	renderStyleInstruction:
		"Return a polished HR dashboard with clean cards, salary highlights, compact tables, and clear action summaries.",
	provider: createGitHubCopilotProvider({
		apiKey: process.env.GITHUB_TOKEN as string,
		model: "openai/gpt-4.1",
	}),
});

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
		role: z.string().min(2),
		department: z.string().min(2).optional(),
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

const prompt =
	Bun.argv.slice(2).join(" ").trim() ||
	"Show the employee roster and summarize the current payroll.";

await router
	.runAndRender(
		prompt,
		"You are a senior HR operations assistant for a Bun SQLite showcase. Use tools before guessing, reflect database changes exactly, summarize payroll impact clearly, and return clean HTML.",
	)
	.then((renderedOutput) => {
		const { content, ...rest } = renderedOutput;
		console.log(rest);
		return Bun.file("output.html").write(content);
	});

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

	const seedEmployees = [
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
	];

	for (const employee of seedEmployees) {
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
	const highestSalary = rows[0]
		? {
				name: rows.reduce((highest, row) => {
					return row.salaryCents > highest.salaryCents ? row : highest;
				}, rows[0]).name,
				salary: fromSalaryCents(
					rows.reduce((highest, row) => {
						return row.salaryCents > highest.salaryCents ? row : highest;
					}, rows[0]).salaryCents,
				),
			}
		: undefined;

	return {
		headcount: rows.length,
		totalPayroll: fromSalaryCents(totalPayroll),
		averageSalary: Number(fromSalaryCents(averageSalary).toFixed(2)),
		highestSalary,
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
