import {
	SHOWCASE_DEFAULT_CONVERSATION_ID,
	SHOWCASE_DEFAULT_PROMPT,
	SHOWCASE_SYSTEM_INSTRUCTION,
	createShowcaseRuntime,
} from "./setup";

const runtime = createShowcaseRuntime();

const { conversationId, prompt } = parseCliArguments(Bun.argv.slice(2));

await runtime.router
	.runAndRender(prompt, SHOWCASE_SYSTEM_INSTRUCTION, { conversationId })
	.then((renderedOutput) => {
		const { content, pendingCorrection, ...rest } = renderedOutput;
		console.log({ ...rest, conversationId });
		if (pendingCorrection) {
			console.log({ pendingCorrection });
		}
		return Bun.file("output.html").write(content);
	});

function parseCliArguments(args: string[]): {
	conversationId: string;
	prompt: string;
} {
	let conversationId =
		process.env.CONVERSATION_ID?.trim() || SHOWCASE_DEFAULT_CONVERSATION_ID;
	const promptParts: string[] = [];

	for (const arg of args) {
		if (arg.startsWith("--conversation=")) {
			conversationId =
				arg.slice("--conversation=".length).trim() || conversationId;
			continue;
		}

		promptParts.push(arg);
	}

	return {
		conversationId,
		prompt: promptParts.join(" ").trim() || SHOWCASE_DEFAULT_PROMPT,
	};
}
