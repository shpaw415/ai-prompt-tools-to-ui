import { useEffect, useRef, useState } from "react";
import {
	AgenticFlowClient,
	createFetchAgenticFlowTransport,
	type AgenticFlowState,
	type AgenticPendingCorrection,
} from "ai-prompt-tools-to-ui/client";

const transport = createFetchAgenticFlowTransport({
	baseUrl: "/api/flow",
});

const client = new AgenticFlowClient({
	transport,
});

const defaultConversationId = client.startConversation("react-example");

export function App() {
	const [flowState, setFlowState] = useState<AgenticFlowState>(client.getState());
	const [prompt, setPrompt] = useState("look up the weather in Paris");
	const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const pendingCorrection = flowState.pendingCorrection;

	useEffect(() => {
		return client.subscribe(setFlowState);
	}, []);

	useEffect(() => {
		if (!flowState.pendingCorrection) {
			setFieldValues({});
		}
	}, [flowState.pendingCorrection]);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!prompt.trim() || busy) {
			return;
		}

		const controller = new AbortController();
		abortRef.current = controller;
		setBusy(true);

		try {
			for await (const _event of client.stream(prompt, {
				conversationId: flowState.conversationId ?? defaultConversationId,
				resetContent: true,
				signal: controller.signal,
			})) {
				// State updates are propagated through client.subscribe().
			}
			setPrompt("");
		} catch (error) {
			console.error(error);
		} finally {
			setBusy(false);
			abortRef.current = null;
		}
	}

	async function handleResume(
		pendingCorrection: AgenticPendingCorrection,
		confirmed?: boolean,
	) {
		if (busy) {
			return;
		}

		const controller = new AbortController();
		abortRef.current = controller;
		setBusy(true);

		try {
			for await (const _event of client.resumeCorrectionStream({
				pendingCorrection,
				conversationId: flowState.conversationId,
				values: Object.fromEntries(
					Object.entries(fieldValues).filter(([, value]) => value.trim().length > 0),
				),
				confirmed,
				resetContent: true,
				signal: controller.signal,
			})) {
				// State updates are propagated through client.subscribe().
			}
		} catch (error) {
			console.error(error);
		} finally {
			setBusy(false);
			abortRef.current = null;
		}
	}

	async function handleReset() {
		if (busy) {
			return;
		}

		await client.reset({
			conversationId: flowState.conversationId ?? defaultConversationId,
			clearRemote: true,
		});
		client.setConversationId(defaultConversationId);
	}

	function handleAbort() {
		abortRef.current?.abort();
	}

	return (
		<div style={styles.page}>
			<div style={styles.shell}>
				<header style={styles.header}>
					<div>
						<h1 style={styles.title}>React SDK example</h1>
						<p style={styles.muted}>
							Client-side React app using AgenticFlowClient and
							 createFetchAgenticFlowTransport.
						</p>
					</div>
					<div style={styles.badges}>
						<span style={styles.badge}>status: {flowState.status}</span>
						<span style={styles.badge}>
							conversation: {flowState.conversationId ?? defaultConversationId}
						</span>
					</div>
				</header>

				<form onSubmit={handleSubmit} style={styles.form}>
					<textarea
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="Ask the backend to use tools"
						rows={4}
						style={styles.textarea}
					/>
					<div style={styles.actions}>
						<button type="submit" disabled={busy} style={styles.primaryButton}>
							Send prompt
						</button>
						<button type="button" onClick={handleReset} disabled={busy} style={styles.button}>
							Reset
						</button>
						<button type="button" onClick={handleAbort} disabled={!busy} style={styles.button}>
							Abort
						</button>
					</div>
				</form>

				{pendingCorrection ? (
					<section style={styles.panel}>
						<h2 style={styles.sectionTitle}>Interactive correction</h2>
						<p style={styles.muted}>{pendingCorrection.message}</p>
						<div style={styles.correctionFields}>
							{pendingCorrection.fields.map((field) => (
								<label key={field.name} style={styles.label}>
									<span>{field.name}</span>
									<input
										value={fieldValues[field.name] ?? ""}
										onChange={(event) => {
											setFieldValues((current) => ({
												...current,
												[field.name]: event.target.value,
											}));
										}}
										placeholder={field.message}
										style={styles.input}
									/>
								</label>
							))}
						</div>
						<div style={styles.actions}>
							<button
								type="button"
								onClick={() => handleResume(pendingCorrection)}
								disabled={busy}
								style={styles.primaryButton}
							>
								Resume
							</button>
							{pendingCorrection.reason === "confirmation-required" ? (
								<button
									type="button"
									onClick={() => handleResume(pendingCorrection, true)}
									disabled={busy}
									style={styles.button}
								>
									Confirm
								</button>
							) : null}
						</div>
					</section>
				) : null}

				<div style={styles.grid}>
					<section style={styles.panel}>
						<h2 style={styles.sectionTitle}>Summary</h2>
						<pre style={styles.pre}>{flowState.content || "No response yet."}</pre>
					</section>

					<section style={styles.panel}>
						<h2 style={styles.sectionTitle}>Planned tool calls</h2>
						<pre style={styles.pre}>
							{JSON.stringify(flowState.plannedToolCalls, null, 2) || "[]"}
						</pre>
					</section>

					<section style={styles.panel}>
						<h2 style={styles.sectionTitle}>Tool results</h2>
						<pre style={styles.pre}>
							{JSON.stringify(flowState.toolCalls, null, 2) || "[]"}
						</pre>
					</section>

					<section style={styles.panel}>
						<h2 style={styles.sectionTitle}>Error</h2>
						<pre style={styles.pre}>{flowState.error?.message ?? "No error"}</pre>
					</section>
				</div>
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	page: {
		background: "linear-gradient(135deg, #f8f4ed 0%, #dbe9f4 100%)",
		color: "#102033",
		fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
		minHeight: "100vh",
		padding: "32px 20px",
	},
	shell: {
		margin: "0 auto",
		maxWidth: "1100px",
	},
	header: {
		alignItems: "start",
		display: "flex",
		gap: "16px",
		justifyContent: "space-between",
		marginBottom: "24px",
	},
	title: {
		fontSize: "2.3rem",
		lineHeight: 1,
		margin: 0,
	},
	muted: {
		color: "#42556b",
		margin: "8px 0 0",
	},
	badges: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},
	badge: {
		background: "rgba(16, 32, 51, 0.08)",
		borderRadius: "999px",
		fontSize: "0.85rem",
		padding: "8px 12px",
	},
	form: {
		background: "rgba(255, 255, 255, 0.72)",
		backdropFilter: "blur(12px)",
		border: "1px solid rgba(16, 32, 51, 0.12)",
		borderRadius: "20px",
		boxShadow: "0 16px 50px rgba(16, 32, 51, 0.08)",
		marginBottom: "20px",
		padding: "20px",
	},
	textarea: {
		background: "#fffdf8",
		border: "1px solid rgba(16, 32, 51, 0.16)",
		borderRadius: "14px",
		color: "#102033",
		font: "inherit",
		padding: "14px 16px",
		resize: "vertical",
		width: "100%",
	},
	actions: {
		display: "flex",
		flexWrap: "wrap",
		gap: "12px",
		marginTop: "16px",
	},
	button: {
		background: "white",
		border: "1px solid rgba(16, 32, 51, 0.16)",
		borderRadius: "999px",
		cursor: "pointer",
		font: "inherit",
		padding: "10px 16px",
	},
	primaryButton: {
		background: "#102033",
		border: "1px solid #102033",
		borderRadius: "999px",
		color: "white",
		cursor: "pointer",
		font: "inherit",
		padding: "10px 16px",
	},
	grid: {
		display: "grid",
		gap: "16px",
		gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
	},
	panel: {
		background: "rgba(255, 255, 255, 0.72)",
		backdropFilter: "blur(12px)",
		border: "1px solid rgba(16, 32, 51, 0.12)",
		borderRadius: "18px",
		boxShadow: "0 12px 36px rgba(16, 32, 51, 0.08)",
		padding: "18px",
	},
	sectionTitle: {
		fontSize: "1rem",
		margin: "0 0 12px",
	},
	pre: {
		background: "#f6f8fb",
		borderRadius: "12px",
		fontFamily: '"IBM Plex Mono", monospace',
		fontSize: "0.85rem",
		margin: 0,
		overflow: "auto",
		padding: "14px",
		whiteSpace: "pre-wrap",
	},
	correctionFields: {
		display: "grid",
		gap: "12px",
		gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
	},
	label: {
		display: "grid",
		fontSize: "0.9rem",
		gap: "6px",
	},
	input: {
		background: "#fffdf8",
		border: "1px solid rgba(16, 32, 51, 0.16)",
		borderRadius: "12px",
		font: "inherit",
		padding: "10px 12px",
	},
};
