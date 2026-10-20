import os from "node:os"
import path from "node:path"

export interface Args {
  /** Directory for per-run debug logs; undefined when logging is off. */
  debugLogDir?: string
}

export const USAGE = "Usage: claude-as-an-mcp [--debug-log [dir]]"

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg === "--debug-log") {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        args.debugLogDir = expandHome(next)
        i++
      } else {
        args.debugLogDir = defaultLogDir(env)
      }
    } else if (arg.startsWith("--debug-log=")) {
      args.debugLogDir = expandHome(arg.slice("--debug-log=".length))
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`)
    }
  }
  return args
}

export function defaultLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(state, "claude-as-an-mcp")
}

// OpenCode passes arguments without a shell, so `~` would otherwise stay literal.
function expandHome(dir: string): string {
  if (dir === "~" || dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(1))
  return path.resolve(dir)
}
