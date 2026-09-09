import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		hookTimeout: 30_000,
		include: ["test/**/*.test.ts"],
		globalSetup: ["./test/vitest.global-setup.ts"],
		pool: "forks",
		runner: "./test/vitest.runner.ts",
		setupFiles: ["./test/vitest.setup.ts"],
		teardownTimeout: 10_000,
		testTimeout: 5_000,
	},
});
