import {
	createJsonResponse,
	createAgenticFlowServerAdapter,
	createAgenticFlowWebHandlers,
} from "../server";
import { SHOWCASE_SYSTEM_INSTRUCTION, createShowcaseRuntime } from "./setup";

const runtime = createShowcaseRuntime();
const adapter = createAgenticFlowServerAdapter({
	router: runtime.router,
	historyProvider: runtime.historyProvider,
});
const handlers = createAgenticFlowWebHandlers({
	adapter,
	onError(error) {
		console.error("[showcase] request failed", error);
		return createJsonResponse(
			{
				error: toMessage(error),
			},
			{ status: 500 },
		);
	},
});
const htmlFile = Bun.file(new URL("./app.html", import.meta.url));
const clientBundle = await buildClientBundle();
const port = Number(process.env.PORT ?? 3001);

Bun.serve({
	port,
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			return new Response(htmlFile, {
				headers: {
					"content-type": "text/html; charset=utf-8",
				},
			});
		}

		if (url.pathname === "/app.js") {
			return new Response(clientBundle, {
				headers: {
					"cache-control": "no-cache",
					"content-type": "text/javascript; charset=utf-8",
				},
			});
		}

		if (url.pathname === "/api/showcase/overview") {
			return createJsonResponse({
				...runtime.getOverview(),
				systemInstruction: SHOWCASE_SYSTEM_INSTRUCTION,
			});
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		if (url.pathname === "/api/flow/run") {
			return handlers.run(request);
		}

		if (url.pathname === "/api/flow/stream") {
			return handlers.stream(request);
		}

		if (url.pathname === "/api/flow/reset" && handlers.reset) {
			return handlers.reset(request);
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`showcase web UI available at http://localhost:${port}`);

async function buildClientBundle(): Promise<Blob> {
	const result = await Bun.build({
		entrypoints: [new URL("./app.js", import.meta.url).pathname],
		format: "esm",
		target: "browser",
		minify: false,
		sourcemap: "inline",
	});

	if (!result.success) {
		throw new Error(
			`Failed to build showcase browser bundle: ${result.logs
				.map((log) => log.message)
				.join("; ")}`,
		);
	}

	const output = result.outputs[0];
	if (!output) {
		throw new Error("Bun.build did not return a browser bundle.");
	}

	return output;
}

function toMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return typeof error === "string" ? error : "Unknown server error.";
}
