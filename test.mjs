// End-to-end tests: drives server.mjs over stdio and checks real power assertions via pmset/pgrep.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childrenOf = (pid) => {
  try { return execFileSync("pgrep", ["-P", String(pid), "caffeinate"]).toString().trim().split("\n").filter(Boolean); } catch { return []; }
};
const assertions = () => execFileSync("pmset", ["-g", "assertions"]).toString();
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

function client() {
  const proc = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, AWAKE_NOTIFY: "false" } });
  const lines = [];
  const waiters = new Map();
  createInterface({ input: proc.stdout }).on("line", (l) => {
    lines.push(l);
    const m = JSON.parse(l);
    waiters.get(m.id)?.(m);
  });
  let next = 1;
  const rpc = (method, params) => new Promise((res) => { const id = next++; waiters.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { isError: r.result.isError, data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
  };
  const notify = (method) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { proc, rpc, call, notify, lines };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n ", e.message); }
}

await test("handshake, notifications are silent, tools listed", async () => {
  const c = client();
  const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  c.notify("notifications/initialized");
  const list = await c.rpc("tools/list", {});
  assert.equal(c.lines.length, 2, "notification must not produce output");
  assert.deepEqual(list.result.tools.map((t) => t.name), ["awake_start", "awake_ping", "awake_stop", "awake_status"]);
  const unk = await c.rpc("nope", {});
  assert.equal(unk.error.code, -32601);
  assert.equal((await c.rpc("ping", {})).result !== undefined, true);
  c.proc.kill();
});

await test("start creates assertions (display on), stop removes them", async () => {
  const c = client();
  const s = await c.call("awake_start", { display: true, reason: "test" });
  assert.equal(s.data.active, true);
  await sleep(300);
  const a = assertions();
  assert.match(a, new RegExp(`pid ${s.data.pid}\\(caffeinate\\).*PreventUserIdleSystemSleep`));
  assert.match(a, new RegExp(`pid ${s.data.pid}\\(caffeinate\\).*PreventUserIdleDisplaySleep`));
  const st = await c.call("awake_stop");
  assert.equal(st.data.released, true);
  await sleep(300);
  assert.equal(pidAlive(s.data.pid), false);
  assert.doesNotMatch(assertions(), new RegExp(`pid ${s.data.pid}\\(caffeinate\\)`));
  c.proc.kill();
});

await test("display=false only prevents system sleep", async () => {
  const c = client();
  const s = await c.call("awake_start", {});
  await sleep(300);
  const mine = assertions().split("\n").filter((l) => l.includes(`pid ${s.data.pid}(caffeinate)`)).join("\n");
  assert.match(mine, /PreventUserIdleSystemSleep/);
  assert.doesNotMatch(mine, /PreventUserIdleDisplaySleep/);
  c.proc.kill();
});

await test("restart replaces instead of stacking", async () => {
  const c = client();
  const a = await c.call("awake_start", {});
  const b = await c.call("awake_start", { display: true });
  await sleep(300);
  assert.notEqual(a.data.pid, b.data.pid);
  assert.equal(pidAlive(a.data.pid), false);
  // only the main caffeinate (user-activity nudges are 1s and may overlap briefly)
  assert.equal(childrenOf(c.proc.pid).filter((p) => p === String(b.data.pid)).length, 1);
  await sleep(1500);
  assert.deepEqual(childrenOf(c.proc.pid), [String(b.data.pid)]);
  c.proc.kill();
});

await test("idle timeout releases; ping extends", async () => {
  const c = client();
  const s = await c.call("awake_start", { idle_timeout_minutes: 0.05 }); // 3s
  await sleep(2000);
  await c.call("awake_ping");
  await sleep(2000); // 4s since start, 2s since ping: still alive thanks to ping
  assert.equal(pidAlive(s.data.pid), true, "ping should have extended the deadline");
  await sleep(1800);
  assert.equal(pidAlive(s.data.pid), false, "should release after idle timeout");
  const st = await c.call("awake_status");
  assert.equal(st.data.active, false);
  assert.equal(st.data.last_release.reason, "idle timeout");
  c.proc.kill();
});

await test("max duration releases even with steady pings", async () => {
  const c = client();
  const s = await c.call("awake_start", { idle_timeout_minutes: 1, max_minutes: 0.05 }); // 3s cap
  for (let i = 0; i < 4; i++) { await sleep(1000); await c.call("awake_ping"); }
  await sleep(300);
  assert.equal(pidAlive(s.data.pid), false);
  assert.equal((await c.call("awake_status")).data.last_release.reason, "max duration reached");
  c.proc.kill();
});

await test("client disconnect (stdin EOF) releases", async () => {
  const c = client();
  const s = await c.call("awake_start", {});
  c.proc.stdin.end();
  await new Promise((r) => c.proc.on("exit", r));
  await sleep(300);
  assert.equal(pidAlive(s.data.pid), false);
});

await test("server SIGKILL: caffeinate exits on its own (-w)", async () => {
  const c = client();
  const s = await c.call("awake_start", { display: true });
  c.proc.kill("SIGKILL");
  for (let i = 0; i < 20 && pidAlive(s.data.pid); i++) await sleep(250);
  assert.equal(pidAlive(s.data.pid), false);
});

await test("bad params return isError", async () => {
  const c = client();
  const r = await c.call("awake_start", { idle_timeout_minutes: "abc" });
  assert.equal(r.isError, true);
  const r2 = await c.call("awake_start", { max_minutes: 0 });
  assert.equal(r2.isError, true);
  const r3 = await c.call("awake_start", { max_minutes: 1e9 }); // would overflow setTimeout
  assert.equal(r3.isError, true);
  const r4 = await c.rpc("tools/call", { name: "awake_status", arguments: null });
  assert.equal(r4.result.isError, undefined);
  assert.equal((await c.call("awake_status")).data.active, false, "rejected starts must not leave a hold");
  c.proc.kill();
});

await test("invalid env defaults fall back instead of breaking start", async () => {
  const proc = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AWAKE_IDLE_MINUTES: "abc", AWAKE_MAX_MINUTES: "99999999" } });
  const out = [];
  createInterface({ input: proc.stdout }).on("line", (l) => out.push(JSON.parse(l)));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "awake_start", arguments: {} } }) + "\n");
  while (!out.length) await sleep(50);
  const data = JSON.parse(out[0].result.content[0].text);
  assert.equal(data.idle_timeout_minutes, 30);
  assert.equal(data.max_minutes, 240);
  proc.kill();
});

const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
