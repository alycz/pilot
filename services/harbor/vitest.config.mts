import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests stay in the ordinary Vite pool so CI is fully offline and does not
// start a local Worker runtime or bind a network port. Live Worker coverage is
// intentionally confined to `npm run test:smoke`.
export default defineConfig({
	resolve: {
		alias: [
			{
				find: "cloudflare:workers",
				replacement: fileURLToPath(
					new URL("./test/cloudflare-workers.ts", import.meta.url),
				),
			},
			{
				find: /emscripten-module\.wasm\?module$/,
				replacement: fileURLToPath(
					new URL("./test/quickjs-wasm-module.ts", import.meta.url),
				),
			},
		],
	},
	test: {
		exclude: ["test/smoke/**", "node_modules/**"],
		server: {
			deps: {
				external: [/quickjs-emscripten/, /@jitl\/quickjs/],
			},
		},
	},
});
