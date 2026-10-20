import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests spawn the server as a child process.
    testTimeout: 30_000,
  },
})
