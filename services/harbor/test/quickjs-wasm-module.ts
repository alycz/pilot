import { readFileSync } from "node:fs";

const wasmUrl = new URL(
	"../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
	import.meta.url,
);

export default await WebAssembly.compile(readFileSync(wasmUrl));
