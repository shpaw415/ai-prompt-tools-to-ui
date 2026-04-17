import { AgenticRouter, createGitHubCopilotProvider, z } from "../";
import { searchPlugins } from "frame-master/search/plugin";

const router = new AgenticRouter({
	useStreaming: true,
	outputFormat: "html",
	renderStyle: "inline-css",
	renderStyleInstruction:
		"Return a polished plugin discovery UI with clean cards, badges, and clear call-to-action buttons.",
	provider: createGitHubCopilotProvider({
		apiKey: process.env.GITHUB_TOKEN as string,
		model: "openai/gpt-4.1",
	}),
});

router.registerTool(
	"frame_master_plugin_search",
	"search a plugin in the Frame Master Plugin Store",
	z.object({
		query: z.string(),
	}),
	({ query }) => {
		return searchPlugins().query(query).execute();
	},
);

router.registerTool(
	"frame_master_plugin_get_details",
	"get details of a plugin in the Frame Master Plugin Store",
	z.object({
		pluginId: z.string(),
	}),
	({ pluginId }) => {
		return searchPlugins().name(pluginId).execute();
	},
);

router.registerTool(
	"frame_master_plugin_install",
	"install a plugin from the Frame Master Plugin Store to the user's Frame Master instance",
	z.object({
		pluginId: z.string(),
	}),
	({ pluginId }) => {
		return Bun.$`bun i ${pluginId}`;
	},
);

await router
	.runAndRender(
		Bun.argv.slice(2).join(" "),
		"You are a senior Frame Master plugin assistant. Use tools first, rank results by relevance, and return clean HTML.",
	)
	.then((renderedOutput) => {
		const { content, ...rest } = renderedOutput;
		console.log(rest);
		return Bun.file("output.html").write(content);
	});
