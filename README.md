# claude-as-an-mcp

A local MCP server that lets [OpenCode](https://opencode.ai) hand tasks to [Claude Code](https://code.claude.com). It exposes one tool, which runs Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) in your project and returns its final reply.

Claude Code runs as your own setup: Claude Code's system prompt plus your user, project and local settings, `CLAUDE.md` files, skills, agents, hooks and MCP servers.

## Requirements

- Node.js 20 or later
- OpenCode 2.x
- A Claude Code login on this machine (`claude` → `/login`), or an `ANTHROPIC_API_KEY` in the environment

The SDK ships its own Claude Code binary, so a separate Claude Code install isn't needed. It still uses the same `~/.claude` login and settings as your `claude` CLI.

## Install

```sh
git clone https://github.com/Yihao-G/claude-as-an-mcp.git
cd claude-as-an-mcp
npm install
npm run build
```

Check that it can reach Claude Code with your login:

```sh
npm run smoke
```

The smoke test starts a session in a scratch directory, then continues it by `session_id`, using two short prompts.

## Add it to OpenCode

Add the server to your global config, `~/.config/opencode/opencode.json`, so it's available in every project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "claude": {
        "type": "local",
        "command": ["node", "/absolute/path/to/claude-as-an-mcp/dist/index.js"],
        "codemode": false
      }
    }
  }
}
```

- `codemode: false` gives OpenCode's model the tool directly, with its full description, instead of through Code Mode.
- Don't set a numeric `timeout`. OpenCode applies a number to every phase, including tool execution, so it would cut off long runs. If you need one, set only `{ "startup": …, "catalog": … }`.

OpenCode starts the server in the project directory, and new Claude Code sessions run there.

## The tool

OpenCode shows the tool as `claude_code`: the server key `claude` plus the tool name `code`.

| Parameter | |
| --- | --- |
| `prompt` | Required. The task, or the next message when continuing a session. |
| `session_id` | Continue that Claude Code session. It always runs in the directory it started in. |
| `cwd` | Directory for a new session, relative to the project directory. Defaults to the project directory. |
| `model` | Claude Code model alias or ID, such as `opus` or `sonnet`. Defaults to your Claude Code setting. |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`. Defaults to your Claude Code setting. |

The call blocks until Claude Code finishes, sending progress notifications every five seconds. Cancelling the call in OpenCode stops Claude Code. The result is a short header followed by Claude Code's final reply:

```
status: completed
session_id: 0f9c3a52-…
refused:
- Bash: git push origin main (Blocked by classifier)

<Claude Code's reply>
```

`refused` appears only when Claude Code was refused an action. A failed run comes back as a tool error, with `status: error` and, when known, the `session_id`.

### How Claude Code runs

- **Permissions.** Runs use auto mode, where a classifier approves or blocks each action. If auto mode isn't available for your account or model, runs fall back to `acceptEdits`. Nobody is around to approve anything, so an action that would need approval is refused, and the result lists it.
- **Questions and plans.** Claude Code's question tool and plan-mode tools are disabled. When Claude Code needs something, it asks in its reply, and OpenCode answers by calling the tool again with the `session_id`.
- **Read-only work.** There's no read-only switch. For reviews, investigations and plans, the prompt tells Claude Code not to change anything; the tool description tells OpenCode's model to do this.
- **Parallel runs.** Runs aren't queued. The tool description tells OpenCode not to run two tasks that may change files in the same directory at once.
- **Sessions.** Every run is saved like any Claude Code session, so you can open one in a terminal with `claude --resume <session_id>` from its directory.

## Authentication

Claude Code authenticates the same way your `claude` CLI does, and the server passes its environment through unchanged. OpenCode starts the server with its own environment, so an `ANTHROPIC_API_KEY` there takes precedence over your Claude Code login, and runs are billed to that key.

## Options

| | |
| --- | --- |
| `--debug-log [dir]` | Write a live log of each run: the prompt, tool calls, replies, refusals, cost and token counts. Logs go to `$XDG_STATE_HOME/claude-as-an-mcp`, or `~/.local/state/claude-as-an-mcp` when that's unset, unless you give a directory. Each result then includes `debug_log: <path>`. |
| `CCMCP_CLAUDE_PATH` | Environment variable. Path to a `claude` executable to use instead of the one bundled with the SDK. |

Both go in the OpenCode entry:

```json
"claude": {
  "type": "local",
  "command": ["node", "/absolute/path/to/claude-as-an-mcp/dist/index.js", "--debug-log"],
  "environment": { "CCMCP_CLAUDE_PATH": "/usr/local/bin/claude" },
  "codemode": false
}
```

`latest.log` in the log directory always points to the newest run, so `tail -F ~/.local/state/claude-as-an-mcp/latest.log` follows each run as it happens.

## Updating Claude Code

The bundled Claude Code version tracks the SDK version: SDK 0.3.304 ships Claude Code 2.1.304. To update:

```sh
npm update @anthropic-ai/claude-agent-sdk
npm run build
```

## Development

```sh
npm test            # unit tests and stdio integration tests; no Claude login needed
npm run typecheck
```

`src/runner.ts` runs Claude Code through the Agent SDK and knows nothing about MCP. `src/server.ts` exposes it as an MCP tool, and `src/index.ts` serves that tool over stdio.

`package.json` pins Vite 6 through `overrides` because Vitest's optional Vite 8 peer dependencies crash npm 10's installer.
