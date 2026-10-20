import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Client } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import { TOOL_DESCRIPTION } from "../src/server.js"
import { connect, fixturePath, textOf } from "./helpers.js"

const clients: Client[] = []
async function start(env: Record<string, string> = {}) {
  const client = await connect(fixturePath("fake-server.ts"), { env })
  clients.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

describe("MCP server over stdio", () => {
  it("offers one `code` tool with the agreed description and parameters", async () => {
    const client = await start()

    const { tools } = await client.listTools()

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("code")
    expect(tools[0]?.description).toBe(TOOL_DESCRIPTION)
    expect(tools[0]?.inputSchema.required).toEqual(["prompt"])
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(["prompt", "session_id", "cwd", "model", "effort"])
  })

  it("passes the arguments to the runner and formats its reply", async () => {
    const client = await start()

    const result = await client.callTool({
      name: "code",
      arguments: { prompt: "echo", session_id: "session-7", cwd: "packages/api", model: "opus", effort: "high" },
      _meta: { "ai.opencode/sessionID": "ses_123" },
    })

    expect(result.isError).toBe(false)
    expect(textOf(result)).toBe(
      [
        "status: completed",
        "session_id: session-7",
        "",
        JSON.stringify({ prompt: "echo", sessionId: "session-7", cwd: "packages/api", model: "opus", effort: "high" }),
      ].join("\n"),
    )
  })

  it("returns failed runs as tool errors that keep the session_id", async () => {
    const client = await start()

    const result = await client.callTool({ name: "code", arguments: { prompt: "fail" } })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      [
        "status: error",
        "session_id: session-failed",
        "refused:",
        "- Bash: git push (Needs approval)",
        "",
        "Claude Code crashed",
      ].join("\n"),
    )
  })

  it("rejects invalid arguments", async () => {
    const client = await start()

    const result = await client.callTool({ name: "code", arguments: { prompt: "echo", effort: "extreme" } })

    expect(result.isError).toBe(true)
  })

  it("sends heartbeats that keep a long call alive", async () => {
    const client = await start()
    const messages: string[] = []

    // The run takes longer than the request timeout; only the heartbeats keep it alive.
    const result = await client.callTool(
      { name: "code", arguments: { prompt: "slow 1500" } },
      { timeout: 500, resetTimeoutOnProgress: true, onprogress: (progress) => messages.push(progress.message ?? "") },
    )

    expect(textOf(result)).toContain("Finished the slow task.")
    expect(messages.length).toBeGreaterThanOrEqual(5)
    expect(messages).toContain("Claude Code: Bash npm test")
  })

  it("stops the run when the client cancels the call", async () => {
    const marker = path.join(mkdtempSync(path.join(os.tmpdir(), "claude-as-an-mcp-test-")), "aborted")
    const client = await start({ ABORT_MARKER: marker })
    const controller = new AbortController()

    const call = client.callTool({ name: "code", arguments: { prompt: "hang" } }, { signal: controller.signal })
    await sleep(300)
    controller.abort()

    await expect(call).rejects.toThrow()
    for (let i = 0; i < 50 && !existsSync(marker); i++) await sleep(100)
    expect(readFileSync(marker, "utf8")).toBe("aborted")
  })

  it("writes a live log per run when debug logging is on", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-as-an-mcp-logs-"))
    const client = await start({ DEBUG_LOG_DIR: directory })

    const result = await client.callTool({
      name: "code",
      arguments: { prompt: "slow 50" },
      _meta: { "ai.opencode/sessionID": "ses_456" },
    })

    const logPath = /^debug_log: (.+)$/m.exec(textOf(result))?.[1]
    expect(logPath && path.dirname(logPath)).toBe(directory)
    await sleep(100)
    const log = readFileSync(logPath ?? "", "utf8")
    expect(log).toContain("opencode session=ses_456")
    expect(log).toContain("prompt: slow 50")
    expect(log).toContain("tool Bash: npm test")
    expect(readlinkSync(path.join(directory, "latest.log"))).toBe(path.basename(logPath ?? ""))
  })

  it("still runs when the debug log cannot be written", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "claude-as-an-mcp-logs-")), "not-a-directory")
    writeFileSync(file, "")
    const client = await start({ DEBUG_LOG_DIR: path.join(file, "logs") })

    const result = await client.callTool({ name: "code", arguments: { prompt: "echo" } })

    expect(result.isError).toBe(false)
    expect(textOf(result)).not.toContain("debug_log:")
  })
})
