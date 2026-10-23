---
name: keep-awake
description: Use BEFORE starting work whenever the user is stepping away or wants you to keep going without them ("I'm heading out", "keep going while I'm away", "work on this overnight", "don't stop until it's done", "keep the computer awake"), or whenever the task is long-running (a build, a test suite, a migration, a multi-file refactor, long research, or any job described as taking more than about 5 minutes, even when you only run a short stand-in for it). Keeps the user's Mac from sleeping mid-task with the awk-mcp `awake_start` / `awake_ping` / `awake_stop` tools, and releases the hold when the work is done or you need the user's input.
---

# Keep the Mac awake while you work

The `awake` MCP server (awk-mcp) stops macOS from sleeping, which would pause your work, while you're busy. It releases the hold when you finish or go quiet. The tools are `awake_start`, `awake_ping`, `awake_stop` and `awake_status`. Depending on the client they may appear with a prefix, e.g. `mcp__awake__awake_start` or `mcp__plugin_awk-mcp_awake__awake_start`.

## When to start

Call `awake_start` **before** the first step of work that is likely to take more than about 5 minutes, or whenever the user signals they're leaving you to it. Don't start it for quick questions, single edits or short replies.

Choose the parameters to fit the task:

| Situation | Parameters |
|---|---|
| Typical long task | defaults (idle 30 min, cap 240 min) |
| A single silent step will run longer than 30 min (big build, long test suite, model training) | `idle_timeout_minutes` a bit longer than that step |
| User says "overnight" or gives a long horizon | `max_minutes` up to `1440` |
| Work needs the screen on, or the user asked to keep it unlocked (GUI automation, browser or simulator driving, screen recording, a dashboard they're watching) | `display: true` |
| Everything else | `display: false` (default). Lets the screen turn off and lock, which is safer while the user is away. |

Always pass a short `reason`, e.g. `"running full test suite + fixing failures"`.

## While working

- Every call to the server resets the idle timer, so `awake_ping` is enough to say "still working".
- Call `awake_ping` before you start a command that will run a long time without output, and at least every `idle_timeout_minutes / 2` during long stretches without tool calls to this server.
- Calling `awake_start` again replaces the current hold. Use it to change the settings mid-task, e.g. to switch `display` on.

## When to release

- **Task done:** call `awake_stop` as part of wrapping up, before the final message.
- **You need the user's input** (a question, an approval, a blocking decision): call `awake_stop` before you ask, unless the user said to keep the machine awake no matter what. If you forget, the idle timeout releases the hold on its own. Stopping explicitly is faster and more polite.
- **Task failed or you're giving up:** call `awake_stop` too.
- If you're unsure whether a hold is active, call `awake_status`.

Never leave a hold running after the work is over just in case. The Mac should be able to sleep once nothing is happening.

## What it can't do

- It **can't unlock** a Mac that is already locked. `display: true` only prevents the *idle* screensaver and auto-lock from triggering.
- It can't stop sleep caused by closing the lid (unless in clamshell mode) or a manual lock.
- macOS only.

If the `awake_*` tools are not available in this session, don't fail the task. Mention once that the user can install them:

```bash
claude plugin marketplace add yhauxell/awk-mcp
claude plugin install awk-mcp@awk-mcp
```

Then continue with the work.

## Example

```
awake_start { "reason": "migrating 40 components to new router", "idle_timeout_minutes": 30 }
... work, edits, tool calls ...
awake_ping {}                      # before `npm run test:e2e` (~20 min, silent)
... more work ...
awake_stop {}                      # done; then send the summary to the user
```
