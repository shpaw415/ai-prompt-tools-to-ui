import { createServer } from "node:http";
import {
	AgenticRouter,
	createInMemoryHistoryProvider,
	createMockLLMProvider,
	z,
} from "../../index";
import {
	createAgenticFlowServerAdapter,
	createAgenticFlowWebHandlers,
} from "../../server/index";

const historyProvider = createInMemoryHistoryProvider();

const router = new AgenticRouter({
	enableInteractiveCorrections: true,
	historyProvider,
	provider: createMockLLMProvider({ model: "mock-node-example" }),
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
			forecast: "sunny",
			temperatureC: 22,
		};
	},
);

const adapter = createAgenticFlowServerAdapter({
	router,
	historyProvider,
});
const handlers = createAgenticFlowWebHandlers({
	adapter,
	onError(error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return new Response(JSON.stringify({ error: message }), {
			status: 500,
			headers: {
				"content-type": "application/json; charset=utf-8",
			},
		});
	},
});

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost:3000");
	const request = await toWebRequest(req, url);

	let response: Response;
	if (req.method === "POST" && url.pathname === "/api/flow/run") {
		response = await handlers.run(request);
	} else if (req.method === "POST" && url.pathname === "/api/flow/stream") {
		response = await handlers.stream(request);
	} else if (
		req.method === "POST" &&
		url.pathname === "/api/flow/reset" &&
		handlers.reset
	) {
		response = await handlers.reset(request);
	} else if (req.method === "GET" && url.pathname === "/health") {
		response = new Response(JSON.stringify({ ok: true }), {
			headers: { "content-type": "application/json; charset=utf-8" },
		});
	} else {
		response = new Response("Not Found", { status: 404 });
	}

	await writeNodeResponse(res, response);
});

server.listen(3000, () => {
	console.log("Node example listening on http://localhost:3000");
	console.log("POST /api/flow/run, /api/flow/stream, /api/flow/reset");
});

async function toWebRequest(
	req: Parameters<typeof createServer>[0],
	url: URL,
): Promise<Request> {
	const body =
		req.method === "GET" || req.method === "HEAD"
			? undefined
			: await readNodeBody(req);

	return new Request(url, {
		method: req.method,
		headers: req.headers as Record<string, string>,
		body,
	});
}

function readNodeBody(
	req: Parameters<typeof createServer>[0],
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
		req.on("error", reject);
	});
}

async function writeNodeResponse(
	res: Parameters<typeof createServer>[1],
	response: Response,
): Promise<void> {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => {
		res.setHeader(key, value);
	});

	if (!response.body) {
		res.end();
		return;
	}

	const reader = response.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		res.write(Buffer.from(value));
	}

	res.end();
}
