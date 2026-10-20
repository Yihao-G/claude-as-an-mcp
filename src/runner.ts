import { stat } from "node:fs/promises"
import path from "node:path"
import {
  getSessionInfo,
  query,
  type EffortLevel,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[]

// Tools that wait for a person to answer. Nobody is on the other end of a run,
// so Claude Code asks its questions in its reply and the caller continues the session.
const DISALLOWED_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]

// The input field that best identifies what a tool call does, in order of preference.
const DETAIL_KEYS = ["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "description", "skill"]

export interface RunRequest {
  prompt: string
  /** Continue this session. It always runs in the directory it was created in. */
  sessionId?: string
  /** Directory for a new session, resolved against the runner's default directory. */
  cwd?: string
  model?: string
  effort?: EffortLevel
}

export interface RefusedAction {
  tool: string
  detail: string
  reason?: string
}

export interface RunStats {
  turns: number
  durationMs: number
  costUsd: number
  usage: unknown
}

export interface RunResult {
  status: "completed" | "error"
  sessionId?: string
  /** Claude Code's final reply, or the error message. */
  text: string
  refused: RefusedAction[]
  stats?: RunStats
}

export type RunEvent =
  | { type: "start"; cwd: string; resume?: string; prompt: string }
  | { type: "init"; sessionId: string; model: string; permissionMode: string; cwd: string; version: string }
  | { type: "fallback"; permissionMode: "acceptEdits" }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "denied"; tool: string; reason: string }
  | { type: "stderr"; text: string }
  | { type: "result"; result: RunResult }

export interface RunOptions {
  signal?: AbortSignal
  onEvent?: (event: RunEvent) => void
}

export type Runner = (request: RunRequest, options?: RunOptions) => Promise<RunResult>

export interface RunnerConfig {
  /** Directory new sessions run in unless a request names another. */
  cwd: string
  /** Claude Code executable to use instead of the one bundled with the SDK. */
  executable?: string
}

export interface Sdk {
  query: typeof query
  getSessionInfo: typeof getSessionInfo
}

export function createRunner(config: RunnerConfig, sdk: Sdk = { query, getSessionInfo }): Runner {
  return async (request, { signal, onEvent = () => {} } = {}) => {
    const finish = (result: RunResult) => {
      onEvent({ type: "result", result })
      return result
    }
    const fail = (text: string, sessionId?: string) => finish({ status: "error", sessionId, text, refused: [] })

    if (signal?.aborted) return fail("Cancelled", request.sessionId)
    const cwd = await workingDirectory(request, config, sdk)
    if (cwd.error !== undefined) return fail(cwd.error, request.sessionId)
    onEvent({ type: "start", cwd: cwd.path, resume: request.sessionId, prompt: request.prompt })

    const abortController = new AbortController()
    const abort = () => abortController.abort()
    signal?.addEventListener("abort", abort, { once: true })

    let endInput = () => {}
    const inputEnded = new Promise<void>((resolve) => (endInput = resolve))
    abortController.signal.addEventListener("abort", () => endInput(), { once: true })

    const options: Options = {
      cwd: cwd.path,
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "auto",
      // Anything that would ask for approval is refused, and the result lists it.
      permissionPrompts: "none",
      disallowedTools: DISALLOWED_TOOLS,
      abortController,
      stderr: (text) => onEvent({ type: "stderr", text }),
      ...(request.sessionId ? { resume: request.sessionId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
    }

    const conversation = sdk.query({ prompt: singleMessage(request.prompt, inputEnded), options })
    const reasons = new Map<string, string>()
    let sessionId = request.sessionId
    let result: SDKResultMessage | undefined
    let lastText = ""
    let fallback: Promise<void> | undefined

    const handle = (message: SDKMessage) => {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id
        onEvent({
          type: "init",
          sessionId: message.session_id,
          model: message.model,
          permissionMode: message.permissionMode,
          cwd: message.cwd,
          version: message.claude_code_version,
        })
        // Claude Code starts in "default" when auto mode isn't available to this
        // account or model, and that mode would refuse every edit.
        if (message.permissionMode === "default") {
          fallback = conversation.setPermissionMode("acceptEdits").then(
            () => onEvent({ type: "fallback", permissionMode: "acceptEdits" }),
            (error) => onEvent({ type: "stderr", text: `Could not switch to acceptEdits: ${errorMessage(error)}` }),
          )
        }
      } else if (message.type === "system" && message.subtype === "permission_denied") {
        const reason = message.decision_reason ?? message.message
        reasons.set(message.tool_use_id, reason)
        onEvent({ type: "denied", tool: message.tool_name, reason })
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && message.parent_tool_use_id === null) {
            lastText = block.text
            onEvent({ type: "text", text: block.text })
          } else if (block.type === "tool_use") {
            onEvent({ type: "tool", name: block.name, detail: describeInput(block.input) })
          }
        }
      } else if (message.type === "result") {
        result = message
        // The turn is over; ending the input lets Claude Code exit.
        endInput()
      }
    }

    try {
      for await (const message of conversation) handle(message)
    } catch (error) {
      // The SDK can throw after yielding an error result, which already says what went wrong.
      if (result === undefined) return fail(abortController.signal.aborted ? "Cancelled" : errorMessage(error), sessionId)
    } finally {
      signal?.removeEventListener("abort", abort)
      endInput()
      await fallback
    }

    if (result === undefined) return fail(abortController.signal.aborted ? "Cancelled" : "Claude Code exited without a result", sessionId)
    return finish(toRunResult(result, reasons, lastText))
  }
}

async function workingDirectory(
  request: RunRequest,
  config: RunnerConfig,
  sdk: Sdk,
): Promise<{ path: string; error?: undefined } | { error: string }> {
  if (request.sessionId) {
    const info = await sdk.getSessionInfo(request.sessionId).catch((error: unknown) => errorMessage(error))
    if (typeof info === "string") return { error: `Cannot look up session_id ${request.sessionId}: ${info}` }
    if (info === undefined) return { error: `Unknown session_id: ${request.sessionId}` }
    return { path: info.cwd ?? config.cwd }
  }
  const directory = path.resolve(config.cwd, request.cwd ?? ".")
  const stats = await stat(directory).catch(() => undefined)
  if (!stats?.isDirectory()) return { error: `cwd is not a directory: ${directory}` }
  return { path: directory }
}

// Streaming input keeps control requests such as setPermissionMode available.
// The input stays open until the turn ends, because closing it ends the session.
async function* singleMessage(prompt: string, ended: Promise<void>): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null }
  await ended
}

function toRunResult(result: SDKResultMessage, reasons: Map<string, string>, lastText: string): RunResult {
  const refused = result.permission_denials.map((denial) => ({
    tool: denial.tool_name,
    detail: describeInput(denial.tool_input),
    reason: reasons.get(denial.tool_use_id),
  }))
  const stats = {
    turns: result.num_turns,
    durationMs: result.duration_ms,
    costUsd: result.total_cost_usd,
    usage: result.usage,
  }
  if (result.subtype === "success" && !result.is_error)
    return { status: "completed", sessionId: result.session_id, text: result.result || lastText, refused, stats }
  const text = result.subtype === "success" ? result.result : result.errors.join("\n") || result.subtype
  return { status: "error", sessionId: result.session_id, text, refused, stats }
}

export function describeInput(input: unknown): string {
  if (input !== null && typeof input === "object") {
    for (const key of DETAIL_KEYS) {
      const value = (input as Record<string, unknown>)[key]
      if (typeof value === "string") return truncate(value)
    }
  }
  return truncate(JSON.stringify(input) ?? "")
}

export function truncate(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
