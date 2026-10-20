import { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod"
import { openDebugLog } from "./debug-log.js"
import { formatResult } from "./format.js"
import { EFFORT_LEVELS, truncate, type RunEvent, type Runner } from "./runner.js"

export const TOOL_NAME = "code"

export const TOOL_DESCRIPTION = [
  "Delegate a task to Claude Code.",
  "Use it when the user asks for Claude Code, or when an independent agent would help: a second opinion or code review, investigating a bug, or a self-contained coding task.",
  "Claude Code can't see this conversation, so put all the context it needs in `prompt`.",
  "Claude Code edits files and runs commands on its own: for reviews, investigations and plans, tell it not to change anything, and when it does change files, ask it to list them in its reply.",
  "A run can take several minutes and returns Claude Code's final reply plus a `session_id`.",
  "Pass the `session_id` back to continue that conversation.",
  "Don't run two tasks that may change files in the same directory at once.",
  "Set `model` or `effort` only when the user asks.",
].join(" ")

const inputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("The task, with all the context Claude Code needs, or your next message when continuing a session."),
  session_id: z.string().min(1).optional().describe("Continue this Claude Code session instead of starting a new one."),
  cwd: z.string().min(1).optional().describe("Directory for a new session. Defaults to the project directory."),
  model: z.string().min(1).optional().describe("Claude Code model alias or ID, such as opus or sonnet."),
  effort: z.enum(EFFORT_LEVELS).optional().describe("Reasoning effort."),
})

export interface ServerConfig {
  name: string
  version: string
  runner: Runner
  /** When set, each run writes a live log into this directory. */
  debugLogDir?: string
  /** How often to send progress notifications while Claude Code works. */
  heartbeatMs?: number
}

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer({ name: config.name, version: config.version }, { capabilities: { tools: {} } })

  server.registerTool(TOOL_NAME, { description: TOOL_DESCRIPTION, inputSchema }, async (args, ctx) => {
    const log = config.debugLogDir === undefined ? undefined : tryOpenDebugLog(config.debugLogDir)
    const caller = ctx.mcpReq._meta?.["ai.opencode/sessionID"]
    if (typeof caller === "string") log?.note(`opencode session=${caller}`)

    let activity = "starting"
    const onEvent = (event: RunEvent) => {
      log?.event(event)
      activity = describeActivity(event) ?? activity
    }

    // Progress notifications keep clients that time out idle calls from giving up on long runs.
    const progressToken = ctx.mcpReq._meta?.progressToken
    let progress = 0
    const heartbeat =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            progress += 1
            ctx.mcpReq
              .notify({
                method: "notifications/progress",
                params: { progressToken, progress, message: `Claude Code: ${activity}` },
              })
              .catch(() => {})
          }, config.heartbeatMs ?? 5_000)

    try {
      const result = await config.runner(
        { prompt: args.prompt, sessionId: args.session_id, cwd: args.cwd, model: args.model, effort: args.effort },
        { signal: ctx.mcpReq.signal, onEvent },
      )
      return {
        content: [{ type: "text", text: formatResult(result, log?.path) }],
        isError: result.status === "error",
      }
    } finally {
      clearInterval(heartbeat)
      log?.close()
    }
  })

  return server
}

// The log is a debugging aid, so failing to write it must not fail the run.
function tryOpenDebugLog(directory: string) {
  try {
    return openDebugLog(directory)
  } catch (error) {
    console.error(`claude-as-an-mcp: cannot write debug log in ${directory}: ${error}`)
    return undefined
  }
}

function describeActivity(event: RunEvent): string | undefined {
  switch (event.type) {
    case "init":
      return "started"
    case "text":
      return "writing"
    case "tool":
      return truncate(`${event.name} ${event.detail}`, 120)
  }
}
