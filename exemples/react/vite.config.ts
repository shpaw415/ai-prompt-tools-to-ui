export default {
	server: {
		port: 5173,
		proxy: {
			"/api/flow": "http://localhost:3000",
		},
	},
};
