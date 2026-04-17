import OUT from "./output.html";

Bun.serve({
	port: 3001,
	routes: {
		"/": OUT,
	},
});
