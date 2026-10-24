import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/smoke/**/*.test.ts"],
		testTimeout: 15_000,
	},
});
