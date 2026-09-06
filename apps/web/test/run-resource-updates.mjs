import { createServer } from "vite";

const server = await createServer({
	server: { middlewareMode: true },
	appType: "custom",
	ssr: {
		noExternal: ["react-router-dom", "react-router"],
		resolve: { conditions: ["module-sync", "module", "development"] },
	},
});
try {
	await server.ssrLoadModule("/test/resource-updates.ts");
} finally {
	await server.close();
}
