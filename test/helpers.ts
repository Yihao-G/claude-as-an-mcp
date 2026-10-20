import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio"

export const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
export const sourcePath = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url))

/**
 * Starts a TypeScript entry point over stdio and connects to it the way OpenCode
 * does: default (2025-era) protocol negotiation, with roots and elicitation advertised.
 */
export async function connect(entry: string, { args = [], env = {} }: { args?: string[]; env?: Record<string, string> } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entry, ...args],
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  })
  const client = new Client(
    { name: "opencode", version: "test" },
    { capabilities: { elicitation: { form: {}, url: {} }, roots: {} } },
  )
  client.setRequestHandler("roots/list", () => ({ roots: [] }))
  await client.connect(transport)
  return client
}

export function textOf(result: { content: unknown[] }): string {
  return result.content
    .map((part) => (part as { type: string; text?: string }).text ?? "")
    .join("\n")
}
