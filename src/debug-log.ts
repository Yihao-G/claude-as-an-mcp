import { randomBytes } from "node:crypto"
import { createWriteStream, mkdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import type { RunEvent } from "./runner.js"

export interface DebugLog {
  readonly path: string
  note(text: string): void
  event(event: RunEvent): void
  close(): void
}

/** Opens a new log file for one run and points `latest.log` at it. */
export function openDebugLog(directory: string): DebugLog {
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const file = path.join(directory, `${stamp}-${randomBytes(3).toString("hex")}.log`)
  const stream = createWriteStream(file, { flags: "a" })
  pointLatestAt(directory, file)

  const note = (text: string) => {
    const [first = "", ...rest] = text.trimEnd().split("\n")
    stream.write(`${new Date().toISOString()} ${[first, ...rest.map((line) => `  ${line}`)].join("\n")}\n`)
  }
  return {
    path: file,
    note,
    event: (event) => note(describe(event)),
    close: () => stream.end(),
  }
}

// Swap the link in one rename so `tail -F latest.log` always follows the newest run.
function pointLatestAt(directory: string, file: string) {
  const temp = path.join(directory, `.latest-${process.pid}-${randomBytes(3).toString("hex")}`)
  try {
    symlinkSync(path.basename(file), temp)
    renameSync(temp, path.join(directory, "latest.log"))
  } catch {
    try {
      unlinkSync(temp)
    } catch {}
  }
}

function describe(event: RunEvent): string {
  switch (event.type) {
    case "start": {
      const options = [
        event.resume && `resume=${event.resume}`,
        event.model && `model=${event.model}`,
        event.effort && `effort=${event.effort}`,
      ].filter(Boolean)
      return `start cwd=${event.cwd}${options.map((option) => ` ${option}`).join("")}\nprompt: ${event.prompt}`
    }
    case "init":
      return `init session=${event.sessionId} model=${event.model}${event.effort ? ` effort=${event.effort}` : ""} mode=${event.permissionMode} cwd=${event.cwd} claude_code=${event.version}`
    case "fallback":
      return `auto mode unavailable, switched to ${event.permissionMode}`
    case "text":
      return `text: ${event.text}`
    case "tool":
      return `tool ${event.name}: ${event.detail}`
    case "denied":
      return `denied ${event.tool}: ${event.reason}`
    case "stderr":
      return `stderr: ${event.text}`
    case "result": {
      const { result } = event
      const stats = result.stats
        ? ` turns=${result.stats.turns} duration_ms=${result.stats.durationMs} cost_usd=${result.stats.costUsd} usage=${JSON.stringify(result.stats.usage)}`
        : ""
      const refused = result.refused.map((action) => `\nrefused ${action.tool}: ${action.detail}`).join("")
      return `result status=${result.status} session=${result.sessionId ?? "-"}${stats}${refused}\n${result.text}`
    }
  }
}
