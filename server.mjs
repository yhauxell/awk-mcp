#!/usr/bin/env node
// awk-mcp: tiny zero-dependency MCP server that keeps a Mac awake while an agent works.
// Uses /usr/bin/caffeinate, tied to this process (-w) so a crash never leaves the Mac pinned awake.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_ALLOWED_MINUTES = 24 * 60; // keeps timers far below setTimeout's 2^31-1 ms ceiling
const log = (...a) => process.stderr.write(`[awk-mcp] ${a.join(" ")}\n`);
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const envMinutes = (k, d) => {
  const n = Number(env(k, d));
  if (n > 0 && n <= MAX_ALLOWED_MINUTES) return n;
  log(`ignoring invalid ${k}=${process.env[k]}; using ${d}`);
  return d;
};
const DEFAULTS = {
  idle_timeout_minutes: envMinutes("AWAKE_IDLE_MINUTES", 30),
  max_minutes: envMinutes("AWAKE_MAX_MINUTES", 240),
  display: env("AWAKE_DISPLAY", "false") === "true",
  notify: env("AWAKE_NOTIFY", "true") === "true",
};
const USER_ACTIVE_EVERY_MS = 30_000; // declares user activity so the screensaver/auto-lock idle timer never fires

let state = null; // { child, nudge, idleTimer, maxTimer, opts, startedAt, idleDeadline, maxDeadline }
let lastRelease = null;

function notify(msg) {
  if (!DEFAULTS.notify) return;
  // message goes in as argv, never spliced into the script
  const script = ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "awk-mcp"', "-e", "end run"];
  const p = spawn("/usr/bin/osascript", [...script, msg], { stdio: "ignore" });
  p.on("error", () => {});
}

function release(reason) {
  if (!state) return false;
  clearTimeout(state.idleTimer);
  clearTimeout(state.maxTimer);
  clearInterval(state.nudge);
  state.child.kill("SIGTERM");
  lastRelease = { reason, at: new Date().toISOString() };
  log("released:", reason);
  if (reason === "idle timeout" || reason === "max duration reached") notify(`Mac may sleep again (${reason}).`);
  state = null;
  return true;
}

function armIdle() {
  if (!state) return;
  clearTimeout(state.idleTimer);
  const ms = state.opts.idle_timeout_minutes * 60_000;
  state.idleDeadline = Date.now() + ms;
  state.idleTimer = setTimeout(() => release("idle timeout"), ms);
}

function start(args) {
  const opts = {
    idle_timeout_minutes: minutes(args.idle_timeout_minutes, DEFAULTS.idle_timeout_minutes, "idle_timeout_minutes"),
    max_minutes: minutes(args.max_minutes, DEFAULTS.max_minutes, "max_minutes"),
    display: typeof args.display === "boolean" ? args.display : DEFAULTS.display,
    reason: typeof args.reason === "string" ? args.reason.slice(0, 200) : "",
  };
  release("restarted");
  const maxSec = Math.ceil(opts.max_minutes * 60);
  const flags = ["-i", "-m", ...(opts.display ? ["-d"] : []), "-t", String(maxSec), "-w", String(process.pid)];
  const child = spawn("/usr/bin/caffeinate", flags, { stdio: "ignore" });
  child.on("error", (e) => log("caffeinate error:", e.message));
  child.on("exit", () => { if (state?.child === child) release("caffeinate exited"); });
  const now = Date.now();
  state = { child, opts, startedAt: now, maxDeadline: now + maxSec * 1000 };
  state.maxTimer = setTimeout(() => release("max duration reached"), maxSec * 1000);
  if (opts.display) {
    // -d keeps the display on but not the screensaver away; a periodic user-activity declaration resets the idle clock.
    const nudge = () => spawn("/usr/bin/caffeinate", ["-u", "-t", "1"], { stdio: "ignore" }).on("error", () => {});
    nudge();
    state.nudge = setInterval(nudge, USER_ACTIVE_EVERY_MS);
  }
  armIdle();
  log("started:", flags.join(" "));
  return status();
}

function minutes(v, d, name) {
  if (v === undefined || v === null) return d;
  const n = Number(v);
  if (!(n > 0 && n <= MAX_ALLOWED_MINUTES)) throw new Error(`${name} must be a number in (0, ${MAX_ALLOWED_MINUTES}]`);
  return n;
}

function status() {
  if (!state) return { active: false, last_release: lastRelease };
  const now = Date.now();
  return {
    active: true,
    pid: state.child.pid,
    display: state.opts.display,
    reason: state.opts.reason,
    idle_timeout_minutes: state.opts.idle_timeout_minutes,
    max_minutes: state.opts.max_minutes,
    idle_release_in_s: Math.round((state.idleDeadline - now) / 1000),
    max_release_in_s: Math.round((state.maxDeadline - now) / 1000),
  };
}

const TOOLS = [
  {
    name: "awake_start",
    description:
      "Keep this Mac awake while you work on a task. Call at the start of long work. Released automatically when you stop calling this server for idle_timeout_minutes (e.g. you are waiting on user input), after max_minutes, or when awake_stop is called. Any call to this server counts as activity; during long tool runs call awake_ping. Calling again replaces the current session.",
    inputSchema: {
      type: "object",
      properties: {
        idle_timeout_minutes: { type: "number", description: `Release after this long with no calls to this server. Default ${DEFAULTS.idle_timeout_minutes}. Fractions allowed.` },
        max_minutes: { type: "number", description: `Hard cap regardless of pings. Default ${DEFAULTS.max_minutes}, max ${MAX_ALLOWED_MINUTES}.` },
        display: { type: "boolean", description: `Also keep the display on and the user marked active, so screensaver/auto-lock does not trigger (cannot unlock an already locked screen). Default ${DEFAULTS.display}.` },
        reason: { type: "string", description: "Optional label shown in status." },
      },
    },
  },
  { name: "awake_ping", description: "Signal you are still working; resets the idle timer.", inputSchema: { type: "object", properties: {} } },
  { name: "awake_stop", description: "Task done: let the Mac sleep normally again.", inputSchema: { type: "object", properties: {} } },
  { name: "awake_status", description: "Show whether the Mac is being kept awake and when it will be released.", inputSchema: { type: "object", properties: {} } },
];

function callTool(name, args) {
  args ??= {};
  switch (name) {
    case "awake_start": return start(args);
    case "awake_ping": if (!state) return { active: false, note: "not active; call awake_start" }; return status();
    case "awake_stop": return { released: release("stopped"), ...status() };
    case "awake_status": return status();
    default: throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "tools/call") armIdle(); // any tool call is activity
  if (id === undefined || id === null) return; // notification
  const ok = (result) => send({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "awk-mcp", version: "0.1.0" },
      });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call":
      try {
        const out = callTool(params?.name, params?.arguments);
        return ok({ content: [{ type: "text", text: JSON.stringify(out) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
      }
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

if (process.platform !== "darwin") log("warning: macOS only (needs /usr/bin/caffeinate)");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  try { handle(msg); } catch (e) { log("handler error:", e.message); }
});
const shutdown = (why) => { release(why); process.exit(0); };
rl.on("close", () => shutdown("client disconnected"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
