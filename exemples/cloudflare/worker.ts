import {
	AgenticRouter,
	createCloudflareD1HistoryProvider,
	createMockLLMProvider,
	z,
} from "../../index";
import {
	createAgenticFlowServerAdapter,
	createAgenticFlowWebHandlers,
	createJsonResponse,
} from "../../server/index";

type Env = {
	HISTORY_DB: import("../../history/cloudflare-d1").CloudflareD1Database;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const router = createRouter();
		const adapter = createAgenticFlowServerAdapter({
			router,
			historyProvider: createCloudflareD1HistoryProvider({
				database: env.HISTORY_DB,
			}),
		});
		const handlers = createAgenticFlowWebHandlers({
			adapter,
			onError(error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				return createJsonResponse({ error: message }, { status: 500 });
			},
		});
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			return createJsonResponse({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/api/flow/run") {
			return handlers.run(request);
		}

		if (request.method === "POST" && url.pathname === "/api/flow/stream") {
			return handlers.stream(request);
		}

		if (
			request.method === "POST" &&
			url.pathname === "/api/flow/reset" &&
			handlers.reset
		) {
			return handlers.reset(request);
		}

		return new Response("Not Found", { status: 404 });
	},
};

function createRouter(): AgenticRouter {
	const router = new AgenticRouter({
		enableInteractiveCorrections: true,
		provider: createMockLLMProvider({ model: "mock-cloudflare-example" }),
		useStreaming: true,
	});

	router.registerTool(
		"lookup_weather",
		"Look up the weather for a city.",
		z.object({
			city: z.string().min(2),
		}),
		async ({ city }) => {
			return {
				city,
				forecast: "windy",
				temperatureC: 18,
			};
		},
	);

	return router;
}
