// The real MCP server over stdio, with a scripted runner in place of Claude Code.
// The prompt picks the behaviour: "echo", "slow <ms>", "fail" or "hang".
import { writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import type { Runner } from "../../src/runner.js"
import { createServer } from "../../src/server.js"

const runner: Runner = async (request, { signal, onEvent } = {}) => {
  const [command, argument] = request.prompt.split(" ")
  onEvent?.({ type: "start", cwd: process.cwd(), prompt: request.prompt })
  switch (command) {
    case "echo":
      return { status: "completed", sessionId: request.sessionId ?? "session-new", text: JSON.stringify(request), refused: [] }
    case "slow":
      onEvent?.({ type: "tool", name: "Bash", detail: "npm test" })
      await sleep(Number(argument))
      return { status: "completed", sessionId: "session-slow", text: "Finished the slow task.", refused: [] }
    case "fail":
      return {
        status: "error",
        sessionId: "session-failed",
        text: "Claude Code crashed",
        refused: [{ tool: "Bash", detail: "git push", reason: "Needs approval" }],
      }
    case "hang":
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }))
      writeFileSync(process.env.ABORT_MARKER ?? "", "aborted")
      return { status: "error", text: "Cancelled", refused: [] }
    default:
      throw new Error(`Unknown fixture command: ${command}`)
  }
}

serveStdio(() =>
  createServer({
    name: "claude-as-an-mcp-test",
    version: "0.0.0",
    runner,
    heartbeatMs: 100,
    debugLogDir: process.env.DEBUG_LOG_DIR || undefined,
  }),
)
