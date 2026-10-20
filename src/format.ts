import { truncate, type RunResult } from "./runner.js"

/** Renders a run as the plain text OpenCode's model reads: a short header, then Claude Code's reply. */
export function formatResult(result: RunResult, debugLog?: string): string {
  const header = [`status: ${result.status}`]
  if (result.sessionId) header.push(`session_id: ${result.sessionId}`)
  if (result.refused.length > 0) {
    header.push("refused:")
    for (const action of result.refused) {
      const reason = action.reason ? ` (${truncate(action.reason)})` : ""
      header.push(`- ${action.tool}: ${action.detail}${reason}`)
    }
  }
  if (debugLog) header.push(`debug_log: ${debugLog}`)
  return `${header.join("\n")}\n\n${result.text}`.trimEnd()
}
