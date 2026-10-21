import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { defaultConfigPath, loadConfig } from "../src/config.js"

function configFile(contents: string) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "claude-as-an-mcp-config-")), "config.json")
  writeFileSync(file, contents)
  return file
}

describe("config", () => {
  it("lives in the XDG config directory", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(path.join("/xdg", "claude-as-an-mcp", "config.json"))
    expect(defaultConfigPath({})).toBe(path.join(os.homedir(), ".config", "claude-as-an-mcp", "config.json"))
  })

  it("has no defaults when the file is missing", () => {
    expect(loadConfig(path.join(os.tmpdir(), "claude-as-an-mcp-missing", "config.json"))).toEqual({})
  })

  it("reads the default model and effort", () => {
    expect(loadConfig(configFile('{ "model": "opus", "effort": "high" }'))).toEqual({ model: "opus", effort: "high" })
  })

  it("rejects malformed JSON", () => {
    const file = configFile('{ "effort": "high", }')
    expect(() => loadConfig(file)).toThrow(`Invalid JSON in ${file}`)
  })

  it("rejects unknown keys and unsupported values", () => {
    expect(() => loadConfig(configFile('{ "effortLevel": "high" }'))).toThrow(/Invalid config in .*effortLevel/s)
    expect(() => loadConfig(configFile('{ "effort": "extreme" }'))).toThrow(/Invalid config in .*effort/s)
  })
})
