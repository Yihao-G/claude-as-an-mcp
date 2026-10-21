import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as z from "zod"
import { EFFORT_LEVELS } from "./runner.js"

const ConfigSchema = z.strictObject({
  /** Model for new sessions when a call doesn't name one. */
  model: z.string().min(1).optional(),
  /** Effort for every run when a call doesn't set one. */
  effort: z.enum(EFFORT_LEVELS).optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(config, "claude-as-an-mcp", "config.json")
}

/** Reads the config file; a missing file means no defaults. Throws on anything invalid. */
export function loadConfig(file: string = defaultConfigPath()): Config {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error instanceof Error ? error.message : error}`)
  }
  const parsed = ConfigSchema.safeParse(json)
  if (!parsed.success) throw new Error(`Invalid config in ${file}:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}
