import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { connect, sourcePath } from "./helpers.js"

describe("entry point", () => {
  it("serves the tool over stdio", async () => {
    const client = await connect(sourcePath("index.ts"))
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(["code"])
      expect(client.getServerVersion()?.name).toBe("claude-as-an-mcp")
    } finally {
      await client.close()
    }
  })

  it("refuses unknown arguments", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", sourcePath("index.ts"), "--verbose"], {
      encoding: "utf8",
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Unknown argument: --verbose")
  })
})
