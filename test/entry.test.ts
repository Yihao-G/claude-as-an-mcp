import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { connect, sourcePath } from "./helpers.js"

// Points the server at a config directory of its own instead of the real ~/.config.
function configHome(config?: string) {
  const home = mkdtempSync(path.join(os.tmpdir(), "claude-as-an-mcp-xdg-"))
  if (config !== undefined) {
    mkdirSync(path.join(home, "claude-as-an-mcp"))
    writeFileSync(path.join(home, "claude-as-an-mcp", "config.json"), config)
  }
  return home
}

function runEntry(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", sourcePath("index.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

describe("entry point", () => {
  it("serves the tool over stdio", async () => {
    const client = await connect(sourcePath("index.ts"), {
      env: { XDG_CONFIG_HOME: configHome('{ "model": "opus", "effort": "high" }') },
    })
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(["code"])
      expect(client.getServerVersion()?.name).toBe("claude-as-an-mcp")
    } finally {
      await client.close()
    }
  })

  it("refuses unknown arguments", () => {
    const result = runEntry(["--verbose"], { XDG_CONFIG_HOME: configHome() })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Unknown argument: --verbose")
  })

  it("refuses to start with an invalid config file", () => {
    const result = runEntry([], { XDG_CONFIG_HOME: configHome('{ "effortLevel": "high" }') })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Invalid config in")
    expect(result.stderr).toContain("effortLevel")
  })
})
