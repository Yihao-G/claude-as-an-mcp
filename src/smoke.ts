// One real round trip through the Agent SDK with your Claude Code login and config:
// start a session in a scratch directory, then continue it by session_id.
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultConfigPath, loadConfig } from "./config.js"
import { formatResult } from "./format.js"
import { createRunner, type RunEvent } from "./runner.js"

const defaults = loadConfig()
const directory = mkdtempSync(path.join(os.tmpdir(), "claude-as-an-mcp-smoke-"))
const runner = createRunner({ cwd: directory, executable: process.env.CCMCP_CLAUDE_PATH || undefined, defaults })

const onEvent = (event: RunEvent) => {
  if (event.type === "start")
    console.log(`Requested model ${event.model ?? "(Claude Code default)"}, effort ${event.effort ?? "(Claude Code default)"}`)
  if (event.type === "init")
    console.log(
      `Claude Code ${event.version}, model ${event.model}${event.effort ? `, effort ${event.effort}` : ""}, permission mode ${event.permissionMode}`,
    )
  if (event.type === "fallback") console.log(`Auto mode unavailable, switched to ${event.permissionMode}`)
}

console.log(`Config ${defaultConfigPath()}: ${JSON.stringify(defaults)}`)
console.log(`Starting a session in ${directory}\n`)
const first = await runner({ prompt: "Reply with exactly: smoke test one. Don't use any tools." }, { onEvent })
console.log(`${formatResult(first)}\n`)
if (first.status !== "completed" || first.sessionId === undefined) process.exit(1)

console.log("Continuing the session\n")
const second = await runner(
  { prompt: "Repeat your previous reply word for word, then add: smoke test two.", sessionId: first.sessionId },
  { onEvent },
)
console.log(`${formatResult(second)}\n`)
process.exit(second.status === "completed" ? 0 : 1)
