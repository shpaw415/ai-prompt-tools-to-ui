import { AgenticFlowClient, createFetchAgenticFlowTransport } from "../client";

const transport = createFetchAgenticFlowTransport({
	baseUrl: "/api/flow",
	resetPath: "reset",
});
const client = new AgenticFlowClient({ transport });

const state = {
	flow: client.getState(),
	overview: null,
	timeline: [],
	renderEventLogged: false,
	lastCompletedContent: "",
	busy: false,
};

const elements = {
	conversationBadge: document.querySelector("#conversation-badge"),
	conversationId: document.querySelector("#conversation-id"),
	correctionPanel: document.querySelector("#correction-panel"),
	fillDefaultButton: document.querySelector("#fill-default-button"),
	metrics: document.querySelector("#metrics"),
	newThreadButton: document.querySelector("#new-thread-button"),
	promptBadge: document.querySelector("#prompt-badge"),
	promptForm: document.querySelector("#prompt-form"),
	promptInput: document.querySelector("#prompt-input"),
	providerBadge: document.querySelector("#provider-badge"),
	providerNotice: document.querySelector("#provider-notice"),
	renderFrame: document.querySelector("#render-frame"),
	resetThreadButton: document.querySelector("#reset-thread-button"),
	roster: document.querySelector("#roster"),
	samplePrompts: document.querySelector("#sample-prompts"),
	statusBadge: document.querySelector("#status-badge"),
	submitButton: document.querySelector("#submit-button"),
	timeline: document.querySelector("#timeline"),
};

client.subscribe((flowState) => {
	state.flow = flowState;
	if (
		flowState.status === "completed" &&
		flowState.content &&
		!flowState.pendingCorrection
	) {
		state.lastCompletedContent = flowState.content;
	}
	if (flowState.conversationId) {
		elements.conversationId.value = flowState.conversationId;
	}
	render();
	if (
		flowState.status === "completed" ||
		flowState.status === "awaiting-input"
	) {
		void refreshOverview();
	}
});

elements.promptForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const prompt = elements.promptInput.value.trim();

	if (!prompt || state.busy) {
		return;
	}

	await submitPrompt(prompt);
});

elements.fillDefaultButton.addEventListener("click", () => {
	elements.promptInput.value = state.overview?.defaultPrompt ?? "";
	elements.promptInput.focus();
});

elements.newThreadButton.addEventListener("click", () => {
	const conversationId = client.startConversation();
	state.lastCompletedContent = "";
	elements.conversationId.value = conversationId;
	state.timeline = [
		createTimelineItem("info", "Started a new conversation", conversationId),
	];
	render();
});

elements.resetThreadButton.addEventListener("click", async () => {
	if (state.busy) {
		return;
	}

	const conversationId = ensureConversationId();
	state.busy = true;
	state.timeline = [
		createTimelineItem(
			"info",
			"Resetting conversation history",
			conversationId,
		),
	];
	render();

	try {
		await client.reset({ conversationId, clearRemote: true });
		client.setConversationId(conversationId);
		state.lastCompletedContent = "";
		state.timeline.unshift(
			createTimelineItem(
				"done",
				"Conversation history cleared",
				conversationId,
			),
		);
		await refreshOverview();
	} catch (error) {
		state.timeline.unshift(
			createTimelineItem("error", "Failed to reset history", toMessage(error)),
		);
	} finally {
		state.busy = false;
		render();
	}
});

elements.samplePrompts.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}

	const prompt = target.dataset.prompt;
	if (!prompt || state.busy) {
		return;
	}

	elements.promptInput.value = prompt;
	await submitPrompt(prompt);
});

elements.correctionPanel.addEventListener("submit", async (event) => {
	const form = event.target;
	if (!(form instanceof HTMLFormElement) || form.id !== "correction-form") {
		return;
	}

	event.preventDefault();
	if (state.busy || !state.flow.pendingCorrection) {
		return;
	}

	const formData = new FormData(form);
	const values = {};

	for (const field of state.flow.pendingCorrection.fields) {
		const value = String(formData.get(field.name) ?? "").trim();
		if (value) {
			values[field.name] = coerceCorrectionFieldValue(field, value);
		}
	}

	const confirmed = formData.get("confirmed") === "true";
	await resumeCorrection(values, confirmed);
});

void refreshOverview().then(() => {
	const conversationId =
		state.overview?.conversationId ??
		client.startConversation("hr-showcase-default");
	client.setConversationId(conversationId);
	elements.conversationId.value = conversationId;
	elements.promptInput.value = state.overview?.defaultPrompt ?? "";
	render();
});

async function submitPrompt(prompt) {
	const conversationId = ensureConversationId();
	state.busy = true;
	state.renderEventLogged = false;
	state.timeline.unshift(
		createTimelineItem("prompt", "Submitted prompt", prompt),
	);
	render();

	try {
		for await (const event of client.stream(prompt, {
			conversationId,
			systemInstruction: state.overview?.systemInstruction,
			resetContent: true,
		})) {
			recordFlowEvent(event);
		}
		elements.promptInput.value = "";
	} catch (error) {
		state.timeline.unshift(
			createTimelineItem("error", "Prompt failed", toMessage(error)),
		);
	} finally {
		state.busy = false;
		render();
	}
}

async function resumeCorrection(values, confirmed) {
	state.busy = true;
	state.renderEventLogged = false;
	state.timeline.unshift(
		createTimelineItem(
			"pause",
			"Resuming paused flow",
			confirmed ? "Confirmation submitted" : JSON.stringify(values),
		),
	);
	render();

	try {
		for await (const event of client.resumeCorrectionStream({
			conversationId: ensureConversationId(),
			values,
			confirmed,
			resetContent: true,
		})) {
			recordFlowEvent(event);
		}
	} catch (error) {
		state.timeline.unshift(
			createTimelineItem("error", "Correction resume failed", toMessage(error)),
		);
	} finally {
		state.busy = false;
		render();
	}
}

function recordFlowEvent(event) {
	switch (event.type) {
		case "tool-call":
			state.timeline.unshift(
				createTimelineItem(
					"tool-call",
					`Planning ${event.toolCall.toolName}`,
					JSON.stringify(event.toolCall.arguments, null, 2),
				),
			);
			break;
		case "tool-result":
			state.timeline.unshift(
				createTimelineItem(
					"tool-result",
					`Completed ${event.result.toolName}`,
					JSON.stringify(event.result.result, null, 2),
				),
			);
			break;
		case "response":
			if (!state.renderEventLogged) {
				state.renderEventLogged = true;
				state.timeline.unshift(
					createTimelineItem(
						"response",
						"Streaming summary response",
						"The model output is being returned as a grounded text summary.",
					),
				);
			}
			break;
		case "needs-user-input":
			state.renderEventLogged = false;
			state.timeline.unshift(
				createTimelineItem(
					"pause",
					"Waiting for input",
					event.response.pendingCorrection?.message ??
						"Additional input is required.",
				),
			);
			break;
		case "done":
			state.renderEventLogged = false;
			state.timeline.unshift(
				createTimelineItem(
					"done",
					"Run completed",
					`${event.response.toolCalls.length} tool result(s) captured.`,
				),
			);
			break;
	}

	render();
}

function ensureConversationId() {
	const currentValue = elements.conversationId.value.trim();
	if (currentValue) {
		client.setConversationId(currentValue);
		return currentValue;
	}

	const conversationId = client.startConversation();
	elements.conversationId.value = conversationId;
	return conversationId;
}

async function refreshOverview() {
	const response = await fetch("/api/showcase/overview");
	if (!response.ok) {
		throw new Error(`Overview request failed: ${response.status}`);
	}

	state.overview = await response.json();
	return state.overview;
}

function render() {
	renderStatus();
	renderProvider();
	renderMetrics();
	renderRoster();
	renderPrompts();
	renderTimeline();
	renderCorrectionPanel();
	renderOutput();
	updateButtons();
}

function renderStatus() {
	const conversationId =
		state.flow.conversationId ||
		elements.conversationId.value.trim() ||
		"No conversation";
	elements.conversationBadge.textContent = conversationId;
	elements.statusBadge.textContent = formatStatus(state.flow.status);
	elements.promptBadge.textContent = state.busy
		? "Streaming"
		: state.flow.pendingCorrection
			? "Needs input"
			: state.flow.lastResponse
				? "Latest response ready"
				: "Awaiting prompt";
}

function renderProvider() {
	elements.providerBadge.textContent =
		state.overview?.providerLabel ?? "Loading provider...";
	elements.providerBadge.dataset.tone =
		state.overview?.providerMode === "mock" ? "accent" : "secondary";
	elements.providerNotice.innerHTML =
		state.overview?.providerMode === "mock"
			? '<div class="notice">Set <code>GITHUB_TOKEN</code> to switch from the mock provider to live GitHub Models output.</div>'
			: "";
}

function renderMetrics() {
	const summary = state.overview?.summary;
	const metrics = summary
		? [
				["Headcount", String(summary.headcount)],
				["Total payroll", formatCurrency(summary.totalPayroll)],
				["Average salary", formatCurrency(summary.averageSalary)],
				[
					"Highest salary",
					summary.highestSalary
						? `${summary.highestSalary.name} · ${formatCurrency(summary.highestSalary.salary)}`
						: "N/A",
				],
			]
		: [
				["Headcount", "..."],
				["Total payroll", "..."],
				["Average salary", "..."],
				["Highest salary", "..."],
			];

	elements.metrics.innerHTML = metrics
		.map(
			([label, value]) => `
				<article class="metric-card">
					<div class="label">${escapeHtml(label)}</div>
					<strong>${escapeHtml(value)}</strong>
				</article>
			`,
		)
		.join("");
}

function renderRoster() {
	const employees = state.overview?.employees ?? [];
	elements.roster.innerHTML = employees.length
		? employees
				.map((employee) => {
					return `
						<article class="roster-card">
							<h4>${escapeHtml(String(employee.name ?? "Unknown"))}</h4>
							<div class="roster-meta">
								<span>${escapeHtml(String(employee.role ?? "Role unavailable"))}</span>
								<span>${formatCurrency(Number(employee.salary ?? 0))}</span>
							</div>
							<div class="roster-meta">
								<span>${escapeHtml(String(employee.department ?? "No department"))}</span>
								<span>${escapeHtml(String(employee.updatedAt ?? ""))}</span>
							</div>
						</article>
					`;
				})
				.join("")
		: '<div class="muted">No employees loaded yet.</div>';
}

function renderPrompts() {
	const prompts = state.overview?.samplePrompts ?? [];
	elements.samplePrompts.innerHTML = prompts
		.map(
			(prompt) => `
				<button class="prompt-chip" type="button" data-prompt="${escapeAttribute(prompt)}">
					${escapeHtml(prompt)}
				</button>
			`,
		)
		.join("");
}

function renderTimeline() {
	if (state.timeline.length === 0) {
		elements.timeline.innerHTML =
			'<div class="timeline-item"><div class="muted">Streamed events will appear here once you run a prompt.</div></div>';
		return;
	}

	elements.timeline.innerHTML = state.timeline
		.slice(0, 18)
		.map(
			(item) => `
				<article class="timeline-item" data-kind="${escapeAttribute(item.kind)}">
					<header>
						<strong>${escapeHtml(item.title)}</strong>
						<small>${escapeHtml(item.at)}</small>
					</header>
					<div class="muted">${formatTimelineDetail(item.detail)}</div>
				</article>
			`,
		)
		.join("");
}

function renderCorrectionPanel() {
	const pendingCorrection = state.flow.pendingCorrection;
	if (!pendingCorrection) {
		elements.correctionPanel.innerHTML = `
			<div class="label">Interactive corrections</div>
			<div class="muted" style="margin-top: 12px;">When a tool needs missing fields or an explicit confirmation, the resume form will appear here.</div>
		`;
		return;
	}

	const fields = pendingCorrection.fields
		.map((field) => renderCorrectionField(field))
		.join("");
	const requiresConfirmation =
		pendingCorrection.reason === "confirmation-required";

	elements.correctionPanel.innerHTML = `
			<div class="label">Interactive corrections</div>
			<div style="margin-top: 12px; display: grid; gap: 12px;">
				<strong>${escapeHtml(pendingCorrection.message)}</strong>
				<div class="muted">Tool: ${escapeHtml(pendingCorrection.toolCall.toolName)}</div>
				<form id="correction-form" style="display: grid; gap: 12px;">
					${fields}
					${requiresConfirmation ? '<input type="hidden" name="confirmed" value="true" />' : ""}
					<div class="actions">
						<button class="secondary" type="submit">${requiresConfirmation ? "Confirm and continue" : "Resume flow"}</button>
					</div>
				</form>
			</div>
		`;
}

function renderOutput() {
	if (state.flow.pendingCorrection) {
		if (state.lastCompletedContent) {
			elements.renderFrame.innerHTML = renderResponsePanel(
				state.lastCompletedContent,
				state.flow.toolCalls,
			);
			return;
		}

		elements.renderFrame.innerHTML = `
			<div class="render-placeholder">
				<div>
					<div class="label">Summary panel</div>
					<p>Interactive corrections are shown in the correction panel. Submit the missing fields there to continue this run.</p>
				</div>
			</div>
		`;
		return;
	}

	if (state.flow.content) {
		elements.renderFrame.innerHTML = renderResponsePanel(
			state.flow.content,
			state.flow.toolCalls,
		);
		return;
	}

	elements.renderFrame.innerHTML = `
		<div class="render-placeholder">
			<div>
				<div class="label">Summary panel</div>
				<p>Run a prompt to stream the agent's grounded summary and raw tool results into this panel.</p>
			</div>
		</div>
	`;
}

function renderResponsePanel(content, toolCalls) {
	const toolMarkup = toolCalls.length
		? toolCalls
				.map((toolCall, index) => {
					return `
						<article class="response-tool-card">
							<div class="label">Tool ${index + 1}</div>
							<strong>${escapeHtml(toolCall.toolName)}</strong>
							<div class="muted">${escapeHtml(toolCall.rationale)}</div>
							<pre class="response-pre">${escapeHtml(JSON.stringify(toolCall.result, null, 2))}</pre>
						</article>
					`;
				})
				.join("")
		: '<div class="muted">No tool results were needed for this response.</div>';

	return `
		<div class="response-panel">
			<section class="response-section">
				<div class="label">Final summary</div>
				<pre class="response-pre">${escapeHtml(content)}</pre>
			</section>
			<section class="response-section">
				<div class="label">Tool results</div>
				<div class="response-tools">${toolMarkup}</div>
			</section>
		</div>
	`;
}

function updateButtons() {
	const disabled = state.busy;
	elements.submitButton.disabled = disabled;
	elements.resetThreadButton.disabled = disabled;
	elements.newThreadButton.disabled = disabled;
	elements.fillDefaultButton.disabled = disabled;
	elements.conversationId.disabled = disabled;
	elements.promptInput.disabled = disabled;
}

function createTimelineItem(kind, title, detail) {
	return {
		kind,
		title,
		detail,
		at: new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}),
	};
}

function formatStatus(status) {
	switch (status) {
		case "idle":
			return "Idle";
		case "running":
			return "Running";
		case "streaming":
			return "Streaming";
		case "awaiting-input":
			return "Needs input";
		case "completed":
			return "Completed";
		case "error":
			return "Error";
		default:
			return status;
	}
}

function formatCurrency(value) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	}).format(value);
}

function formatTimelineDetail(detail) {
	if (!detail) {
		return "";
	}

	if (detail.startsWith("{") || detail.startsWith("[")) {
		return `<pre style="white-space: pre-wrap; margin: 0; font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(detail)}</pre>`;
	}

	return escapeHtml(detail);
}

function toMessage(error) {
	if (error instanceof Error) {
		return error.message;
	}

	return typeof error === "string" ? error : "Unknown error.";
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
	return escapeHtml(value).replaceAll("`", "&#96;");
}

function renderCorrectionField(field) {
	if (Array.isArray(field.enumValues) && field.enumValues.length > 0) {
		return `
			<label class="correction-fields">
				<span>${escapeHtml(field.name)}</span>
				<select class="text-input" name="${escapeAttribute(field.name)}">
					<option value="">Select an option</option>
					${field.enumValues
						.map(
							(value) =>
								`<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`,
						)
						.join("")}
				</select>
			</label>
		`;
	}

	const inputType = field.valueType === "number" ? "number" : "text";
	const extraAttributes =
		field.valueType === "number" ? ' inputmode="decimal" step="any"' : "";

	return `
		<label class="correction-fields">
			<span>${escapeHtml(field.name)}</span>
			<input class="text-input" type="${inputType}" name="${escapeAttribute(field.name)}" placeholder="${escapeAttribute(field.message)}"${extraAttributes} />
		</label>
	`;
}

function coerceCorrectionFieldValue(field, value) {
	if (field.valueType === "number") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return value;
}
