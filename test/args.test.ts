import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseArgs } from "../src/args.js"

describe("parseArgs", () => {
  it("leaves debug logging off by default", () => {
    expect(parseArgs([])).toEqual({})
  })

  it("logs to the XDG state directory when no directory is given", () => {
    expect(parseArgs(["--debug-log"], { XDG_STATE_HOME: "/state" })).toEqual({
      debugLogDir: path.join("/state", "claude-as-an-mcp"),
    })
    expect(parseArgs(["--debug-log"], {})).toEqual({
      debugLogDir: path.join(os.homedir(), ".local", "state", "claude-as-an-mcp"),
    })
  })

  it("accepts a directory, expanding ~", () => {
    expect(parseArgs(["--debug-log", "~/logs"])).toEqual({ debugLogDir: path.join(os.homedir(), "logs") })
    expect(parseArgs(["--debug-log=/var/tmp/cc"])).toEqual({ debugLogDir: "/var/tmp/cc" })
  })

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--verbose"])).toThrow(/Unknown argument: --verbose/)
  })
})
