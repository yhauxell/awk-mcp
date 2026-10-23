# awk-mcp

**Keep your Mac awake while your AI agent works, and let it sleep again once the agent is done or is waiting on you.**

A tiny [MCP](https://modelcontextprotocol.io) server with no dependencies. It's one file of about 180 lines and wraps the `caffeinate` command built into macOS. Your agent calls `awake_start` when it begins a long task. The Mac stays awake until one of these happens:

| Trigger | Mechanism |
|---|---|
| The task is done | the agent calls `awake_stop` |
| The agent is waiting on you | no calls to the server for `idle_timeout_minutes` |
| A safety cap is reached | `max_minutes` passes, and pings can't extend it |
| The client goes away | stdin closes, or the server gets SIGINT/SIGTERM/SIGHUP |
| The server crashes or is `kill -9`'d | `caffeinate -w <server pid>` exits by itself |

When the idle timeout or the cap releases the hold, you get a macOS notification.

> **macOS only.** It needs Node.js 18 or newer and `/usr/bin/caffeinate`, which ships with macOS.

## Install

### Claude Code

```bash
claude mcp add --scope user awake -- npx -y github:yhauxell/awk-mcp
```

Or from a local clone:

```bash
git clone https://github.com/yhauxell/awk-mcp.git
claude mcp add --scope user awake -- node "$PWD/awk-mcp/server.mjs"
```

### Any MCP client (Claude Desktop, Cursor, …)

```json
{
  "mcpServers": {
    "awake": {
      "command": "npx",
      "args": ["-y", "github:yhauxell/awk-mcp"],
      "env": {
        "AWAKE_IDLE_MINUTES": "30",
        "AWAKE_MAX_MINUTES": "240",
        "AWAKE_DISPLAY": "false"
      }
    }
  }
}
```

## Tools

### `awake_start`

Starts keeping the Mac awake. If a session is already active, this call replaces it. All parameters are optional.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `idle_timeout_minutes` | number | `30` | Release after this long with no calls to the server. Fractions are allowed. |
| `max_minutes` | number | `240` | Hard cap. Pings can't extend it. The maximum is `1440` (24 h). |
| `display` | boolean | `false` | Also keep the screen on and stop the screensaver and auto-lock. See below. |
| `reason` | string | `""` | A label echoed back by `awake_status`. Truncated to 200 characters. |

### `awake_ping`
Tells the server you're still working, which resets the idle timer. **Any** tool call to this server resets it too.

### `awake_stop`
The task is done. The Mac can sleep normally again.

### `awake_status`
Returns whether a hold is active, its settings, the seconds left until idle release and until max release, and why the last hold ended.

## Configuration

These environment variables set the defaults. Per-call parameters override them, and invalid values fall back to the built-in default with a warning on stderr.

| Variable | Default | |
|---|---|---|
| `AWAKE_IDLE_MINUTES` | `30` | default `idle_timeout_minutes` |
| `AWAKE_MAX_MINUTES` | `240` | default `max_minutes` |
| `AWAKE_DISPLAY` | `false` | default `display` |
| `AWAKE_NOTIFY` | `true` | show a macOS notification when a hold auto-expires |

## Telling your agent to use it

Agents call tools when their instructions tell them to. Add a line like this to your `CLAUDE.md`, `AGENTS.md`, or system prompt:

```md
Before any task likely to take more than a few minutes, call `awake_start`.
During long silent steps (builds, test suites) call `awake_ping` at least every 20 minutes.
Call `awake_stop` when the task is finished.
```

## What "awake" and "unlocked" mean

- **`display: false`** blocks only idle *system* sleep (`caffeinate -i -m`). The screen can still turn off and lock, but processes, downloads and agents keep running.
- **`display: true`** also keeps the display on (`caffeinate -d`) and declares user activity every 30 s (`caffeinate -u`). The idle screensaver doesn't start, so auto-lock never triggers. On the author's Mac the screensaver was set to 5 minutes. With no keyboard or mouse input for 353 s, it never started.
- It **can't unlock** a Mac that's already locked, and it doesn't prevent a manual lock (⌃⌘Q, hot corners, closing the lid).
- Closing the lid still sleeps the Mac unless it's in clamshell mode with an external display.

## Idle timeout caveat

The server can't tell *"the agent is waiting for the user"* apart from *"the agent is busy with a 40-minute build and not calling me"*. All it sees is the time since the last call. Set `idle_timeout_minutes` longer than your longest silent step, or tell the agent to `awake_ping` during long work.

## Security

- **No network access, no dependencies, no file writes.** The server only reads JSON-RPC from stdin and writes to stdout and stderr.
- **No shell:** child processes run with `spawn` using fixed absolute paths (`/usr/bin/caffeinate`, `/usr/bin/osascript`). Tool arguments never reach a command line, and the notification text goes to `osascript` as an argument, not as script source.
- **Validated input:** numbers must fall within `(0, 1440]`, and the `reason` string is length-capped.
- **No stuck holds:** a crash or a killed server can't leave your Mac awake indefinitely, because `caffeinate` watches the server's PID and exits with it.

## How it works

`awake_start` starts one long-lived process: `caffeinate -i -m [-d] -t <max seconds> -w <server pid>`. The server also runs two JavaScript timers, one for idle and one for max. Whichever fires first kills that process. With `display: true`, a 30-second interval runs a short `caffeinate -u -t 1` to reset the user-idle clock. You can see the live assertions with:

```bash
pmset -g assertions | grep caffeinate
```

## Development

```bash
node test.mjs
```

The tests drive the server over stdio and check **real** power assertions with `pmset -g assertions` and `pgrep`. They cover the handshake and notifications, start/stop, display vs. system-only, restart without stacking, idle timeout and ping extension, the max cap, stdin EOF, `kill -9` cleanup, and input validation. They take about 20 s, and nothing stays held afterwards.

## License

[MIT](LICENSE)
