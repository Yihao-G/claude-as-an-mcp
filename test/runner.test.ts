import { mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Options, Query, SDKMessage, SDKSessionInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import { createRunner, type RunEvent, type Sdk } from "../src/runner.js"

interface Call {
  prompt: string
  options: Options
  modes: string[]
  inputClosed: boolean
}

type Script = (call: Call) => AsyncGenerator<SDKMessage>

// Stands in for the Agent SDK: reads the streamed prompt, replays scripted
// messages, then checks the runner closes its input once the result is out.
function fakeSdk(script: Script, sessions: Record<string, Partial<SDKSessionInfo>> = {}) {
  const calls: Call[] = []
  const query = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const call: Call = { prompt: "", options: params.options ?? {}, modes: [], inputClosed: false }
    calls.push(call)
    async function* run(): AsyncGenerator<SDKMessage> {
      const input = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
      const first = await input.next()
      call.prompt = String((first.value as SDKUserMessage).message.content)
      let sawResult = false
      for await (const message of script(call)) {
        sawResult ||= message.type === "result"
        yield message
      }
      if (sawResult) call.inputClosed = (await input.next()).done === true
    }
    return Object.assign(run(), {
      setPermissionMode: async (mode: string) => {
        call.modes.push(mode)
      },
    }) as unknown as Query
  }) as Sdk["query"]
  const getSessionInfo = (async (sessionId: string) => {
    const session = sessions[sessionId]
    return session && ({ sessionId, summary: "", lastModified: 0, ...session } as SDKSessionInfo)
  }) as Sdk["getSessionInfo"]
  return { sdk: { query, getSessionInfo }, calls }
}

const init = (fields: Record<string, unknown> = {}) =>
  ({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    model: "claude-test",
    permissionMode: "auto",
    cwd: "/project",
    claude_code_version: "2.1.304",
    ...fields,
  }) as unknown as SDKMessage

const assistant = (content: unknown[], parentToolUseId: string | null = null) =>
  ({ type: "assistant", message: { content }, parent_tool_use_id: parentToolUseId, session_id: "session-1" }) as unknown as SDKMessage

const result = (fields: Record<string, unknown> = {}) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    session_id: "session-1",
    num_turns: 3,
    duration_ms: 4200,
    total_cost_usd: 0.12,
    usage: { input_tokens: 10, output_tokens: 20 },
    permission_denials: [],
    ...fields,
  }) as unknown as SDKMessage

function scripted(...messages: SDKMessage[]): Script {
  return async function* () {
    yield* messages
  }
}

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "claude-as-an-mcp-test-"))

describe("runner", () => {
  it("starts Claude Code with the agreed options and returns its reply", async () => {
    const project = tempDir()
    const { sdk, calls } = fakeSdk(scripted(init(), assistant([{ type: "text", text: "Working on it" }]), result()))
    const run = createRunner({ cwd: project }, sdk)

    const outcome = await run({ prompt: "Fix the bug" })

    expect(outcome).toEqual({
      status: "completed",
      sessionId: "session-1",
      text: "Done.",
      refused: [],
      stats: { turns: 3, durationMs: 4200, costUsd: 0.12, usage: { input_tokens: 10, output_tokens: 20 } },
    })
    const [call] = calls
    expect(call?.prompt).toBe("Fix the bug")
    expect(call?.inputClosed).toBe(true)
    expect(call?.options).toMatchObject({
      cwd: project,
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "auto",
      permissionPrompts: "none",
      disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
    })
    expect(call?.options.abortController).toBeInstanceOf(AbortController)
    // Settings, environment and model come from the user's Claude Code setup.
    for (const key of ["settingSources", "env", "resume", "model", "effort", "pathToClaudeCodeExecutable"])
      expect(call?.options).not.toHaveProperty(key)
  })

  it("passes model, effort and the executable override", async () => {
    const { sdk, calls } = fakeSdk(scripted(init(), result()))
    const run = createRunner({ cwd: tempDir(), executable: "/usr/local/bin/claude" }, sdk)

    await run({ prompt: "Review", model: "opus", effort: "high" })

    expect(calls[0]?.options).toMatchObject({
      model: "opus",
      effort: "high",
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    })
  })

  it("applies the default model and effort to new sessions", async () => {
    const { sdk, calls } = fakeSdk(scripted(init(), result()))
    const run = createRunner({ cwd: tempDir(), defaults: { model: "opus", effort: "high" } }, sdk)

    await run({ prompt: "Fix" })
    await run({ prompt: "Fix", model: "sonnet", effort: "max" })

    expect(calls[0]?.options).toMatchObject({ model: "opus", effort: "high" })
    expect(calls[1]?.options).toMatchObject({ model: "sonnet", effort: "max" })
  })

  it("keeps a resumed session's model but applies the default effort", async () => {
    const original = tempDir()
    const { sdk, calls } = fakeSdk(scripted(init(), result()), { "session-9": { cwd: original } })
    const run = createRunner({ cwd: tempDir(), defaults: { model: "opus", effort: "high" } }, sdk)

    await run({ prompt: "Continue", sessionId: "session-9" })
    await run({ prompt: "Continue", sessionId: "session-9", model: "sonnet" })

    expect(calls[0]?.options).not.toHaveProperty("model")
    expect(calls[0]?.options).toMatchObject({ resume: "session-9", effort: "high" })
    expect(calls[1]?.options).toMatchObject({ resume: "session-9", model: "sonnet", effort: "high" })
  })

  it("continues a session in the directory it was created in", async () => {
    const original = tempDir()
    const { sdk, calls } = fakeSdk(scripted(init({ session_id: "session-9" }), result({ session_id: "session-9" })), {
      "session-9": { cwd: original },
    })
    const run = createRunner({ cwd: tempDir() }, sdk)

    const outcome = await run({ prompt: "Go ahead", sessionId: "session-9", cwd: "elsewhere" })

    expect(outcome.sessionId).toBe("session-9")
    expect(calls[0]?.options).toMatchObject({ resume: "session-9", cwd: original })
  })

  it("rejects an unknown session_id without starting Claude Code", async () => {
    const { sdk, calls } = fakeSdk(scripted(result()))
    const run = createRunner({ cwd: tempDir() }, sdk)

    const outcome = await run({ prompt: "Hello", sessionId: "missing" })

    expect(outcome).toEqual({ status: "error", sessionId: "missing", text: "Unknown session_id: missing", refused: [] })
    expect(calls).toHaveLength(0)
  })

  it("reports a failed session lookup as an error", async () => {
    const { sdk, calls } = fakeSdk(scripted(result()))
    sdk.getSessionInfo = (async () => {
      throw new Error("EACCES: permission denied")
    }) as Sdk["getSessionInfo"]

    const outcome = await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Hello", sessionId: "session-2" })

    expect(outcome).toMatchObject({
      status: "error",
      text: "Cannot look up session_id session-2: EACCES: permission denied",
    })
    expect(calls).toHaveLength(0)
  })

  it("resolves cwd against the project directory and rejects missing directories", async () => {
    const project = tempDir()
    mkdirSync(path.join(project, "packages", "api"), { recursive: true })
    const { sdk, calls } = fakeSdk(scripted(init(), result()))
    const run = createRunner({ cwd: project }, sdk)

    await run({ prompt: "Check", cwd: "packages/api" })
    const missing = await run({ prompt: "Check", cwd: "nope" })

    expect(calls[0]?.options.cwd).toBe(path.join(project, "packages", "api"))
    expect(missing).toMatchObject({ status: "error", text: `cwd is not a directory: ${path.join(project, "nope")}` })
    expect(calls).toHaveLength(1)
  })

  it("switches to acceptEdits when auto mode is unavailable", async () => {
    const events: RunEvent[] = []
    const { sdk, calls } = fakeSdk(scripted(init({ permissionMode: "default" }), result()))
    const run = createRunner({ cwd: tempDir() }, sdk)

    await run({ prompt: "Edit things" }, { onEvent: (event) => events.push(event) })

    expect(calls[0]?.modes).toEqual(["acceptEdits"])
    expect(events).toContainEqual({ type: "fallback", permissionMode: "acceptEdits" })
  })

  it("leaves the mode alone when auto mode is available", async () => {
    const { sdk, calls } = fakeSdk(scripted(init({ permissionMode: "auto" }), result()))

    await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Edit things" })

    expect(calls[0]?.modes).toEqual([])
  })

  it("lists refused actions with their reasons", async () => {
    const denied = {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      decision_reason: "Pushing to a remote goes beyond the request",
      message: "Permission denied",
    } as unknown as SDKMessage
    const { sdk } = fakeSdk(
      scripted(
        init(),
        denied,
        result({
          permission_denials: [
            { tool_name: "Bash", tool_use_id: "tool-1", tool_input: { command: "git push origin main" } },
            { tool_name: "Write", tool_use_id: "tool-2", tool_input: { file_path: "/etc/hosts", content: "x" } },
          ],
        }),
      ),
    )

    const outcome = await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Ship it" })

    expect(outcome.refused).toEqual([
      { tool: "Bash", detail: "git push origin main", reason: "Pushing to a remote goes beyond the request" },
      { tool: "Write", detail: "/etc/hosts", reason: undefined },
    ])
  })

  it("reports error results", async () => {
    const apiError = fakeSdk(scripted(init(), result({ is_error: true, result: "Invalid API key · Please run /login" })))
    const maxTurns = fakeSdk(
      scripted(init(), result({ subtype: "error_during_execution", is_error: true, errors: ["Something broke"] })),
    )

    expect(await createRunner({ cwd: tempDir() }, apiError.sdk)({ prompt: "Hi" })).toMatchObject({
      status: "error",
      sessionId: "session-1",
      text: "Invalid API key · Please run /login",
    })
    expect(await createRunner({ cwd: tempDir() }, maxTurns.sdk)({ prompt: "Hi" })).toMatchObject({
      status: "error",
      text: "Something broke",
    })
  })

  it("falls back to the last main-thread text when the result text is empty", async () => {
    const { sdk } = fakeSdk(
      scripted(
        init(),
        assistant([{ type: "text", text: "Here is my review." }]),
        assistant([{ type: "text", text: "Subagent notes" }], "tool-7"),
        result({ result: "" }),
      ),
    )

    const outcome = await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Review" })

    expect(outcome.text).toBe("Here is my review.")
  })

  it("reports tool activity as events", async () => {
    const events: RunEvent[] = []
    const { sdk } = fakeSdk(
      scripted(
        init(),
        assistant([
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Run tests" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } },
        ]),
        result(),
      ),
    )

    await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Fix" }, { onEvent: (event) => events.push(event) })

    expect(events.map((event) => event.type)).toEqual(["start", "init", "tool", "tool", "result"])
    expect(events.filter((event) => event.type === "tool")).toEqual([
      { type: "tool", name: "Bash", detail: "npm test" },
      { type: "tool", name: "Edit", detail: "src/app.ts" },
    ])
  })

  it("cancels the run when the caller aborts", async () => {
    let claudeCodeAborted = false
    const { sdk } = fakeSdk(async function* (call) {
      yield init()
      const signal = call.options.abortController!.signal
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      claudeCodeAborted = true
      throw new Error("Claude Code process aborted by user")
    })
    const controller = new AbortController()
    const run = createRunner({ cwd: tempDir() }, sdk)({ prompt: "Long task" }, { signal: controller.signal })

    setTimeout(() => controller.abort(), 20)

    expect(await run).toEqual({ status: "error", sessionId: "session-1", text: "Cancelled", refused: [] })
    expect(claudeCodeAborted).toBe(true)
  })

  it("does not start Claude Code when already cancelled", async () => {
    const { sdk, calls } = fakeSdk(scripted(result()))
    const controller = new AbortController()
    controller.abort()

    const outcome = await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Hi" }, { signal: controller.signal })

    expect(outcome).toMatchObject({ status: "error", text: "Cancelled" })
    expect(calls).toHaveLength(0)
  })

  it("reports a failure when Claude Code exits without a result", async () => {
    const { sdk } = fakeSdk(scripted(init({ session_id: "session-3" })))

    expect(await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Hi" })).toEqual({
      status: "error",
      sessionId: "session-3",
      text: "Claude Code exited without a result",
      refused: [],
    })
  })

  it("keeps the error result when the SDK throws after yielding it", async () => {
    const { sdk } = fakeSdk(async function* () {
      yield init()
      yield result({ subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns"] })
      throw new Error("Claude Code process exited with code 1")
    })

    expect(await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Hi" })).toMatchObject({
      status: "error",
      text: "Reached maximum number of turns",
    })
  })

  it("reports a thrown error when there is no result", async () => {
    const { sdk } = fakeSdk(async function* () {
      yield init()
      throw new Error("Native CLI binary for linux-x64 not found")
    })

    expect(await createRunner({ cwd: tempDir() }, sdk)({ prompt: "Hi" })).toMatchObject({
      status: "error",
      text: "Native CLI binary for linux-x64 not found",
    })
  })
})
