#!/usr/bin/env node
import { createRequire } from "node:module"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { parseArgs, type Args } from "./args.js"
import { createRunner } from "./runner.js"
import { createServer } from "./server.js"

const { name, version } = createRequire(import.meta.url)("../package.json") as { name: string; version: string }

let args: Args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
}

// OpenCode starts the server in the project directory, so that is where new sessions run.
const runner = createRunner({ cwd: process.cwd(), executable: process.env.CCMCP_CLAUDE_PATH || undefined })

// stdout carries the protocol, so diagnostics go to stderr.
serveStdio(() => createServer({ name, version, runner, debugLogDir: args.debugLogDir }), {
  onerror: (error) => console.error(error),
})
