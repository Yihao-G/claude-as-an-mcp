import { describe, expect, it } from "vitest"
import { formatResult } from "../src/format.js"

describe("formatResult", () => {
  it("puts the status and session_id above the reply", () => {
    const text = formatResult({ status: "completed", sessionId: "session-1", text: "All tests pass.", refused: [] })

    expect(text).toBe("status: completed\nsession_id: session-1\n\nAll tests pass.")
  })

  it("lists refused actions and the debug log path", () => {
    const text = formatResult(
      {
        status: "completed",
        sessionId: "session-1",
        text: "Done, but I could not push.",
        refused: [
          { tool: "Bash", detail: "git push origin main", reason: "Needs approval" },
          { tool: "Write", detail: "/etc/hosts" },
        ],
      },
      "/logs/run.log",
    )

    expect(text).toBe(
      [
        "status: completed",
        "session_id: session-1",
        "refused:",
        "- Bash: git push origin main (Needs approval)",
        "- Write: /etc/hosts",
        "debug_log: /logs/run.log",
        "",
        "Done, but I could not push.",
      ].join("\n"),
    )
  })

  it("renders errors without a session", () => {
    expect(formatResult({ status: "error", text: "Unknown session_id: x", refused: [] })).toBe(
      "status: error\n\nUnknown session_id: x",
    )
  })
})
