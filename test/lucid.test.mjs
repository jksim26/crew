import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { normalize, validate } from "../lib/config.mjs";
import { lucidCall, remember } from "../lib/lucid.mjs";
import { agentEnv } from "../lib/dispatch.mjs";
import { main } from "../lib/cli.mjs";

const base = { repo: "jk/proj", owner_login: "jk" };
const on = normalize({ ...base, lucid_dream: { remember: true } });
const env = { LUCID_URL: "http://pc:7878/mcp", LUCID_TOKEN: "ld-secret-token", APPDATA: os.tmpdir(), XDG_CONFIG_HOME: os.tmpdir() };
const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const okReply = reply({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "saved" }], isError: false } });

test("config: lucid_dream is off by default and validates", () => {
  assert.equal(normalize(base).lucid_dream, null);
  assert.deepEqual(normalize({ ...base, lucid_dream: {} }).lucid_dream, { remember: false, relay: false });
  assert.deepEqual(on.lucid_dream, { remember: true, relay: false });
  assert.ok(validate({ ...base, lucid_dream: { remember: "yes" } }).some((p) => /lucid_dream.remember/.test(p)));
  assert.ok(validate({ ...base, lucid_dream: { rember: true } }).some((p) => /unknown key "lucid_dream.rember"/.test(p)));
  assert.ok(validate({ ...base, lucid_dream: true }).some((p) => /"lucid_dream" must be an object/.test(p)));
});

test("lucidCall: one MCP tools/call with the bearer token; returns the reply text", async () => {
  const seen = [];
  const text = await lucidCall("remember", { text: "x" }, { env, fetchImpl: async (url, o) => { seen.push({ url, o }); return okReply; } });
  assert.equal(text, "saved");
  assert.equal(seen[0].url, "http://pc:7878/mcp");
  assert.equal(seen[0].o.headers.Authorization, "Bearer ld-secret-token");
  assert.match(seen[0].o.headers.Accept, /application\/json/);
  assert.deepEqual(JSON.parse(seen[0].o.body), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: { text: "x" } } });
});

test("lucidCall: failures say what happened and never hold the token", async () => {
  const fails = [
    [reply({}, 401), /refused the token/],
    [reply({}, 500), /answered 500/],
    [reply({ result: { content: [{ text: "no agent named x" }], isError: true } }), /no agent named x/],
    [reply({ error: { message: "unknown tool" } }), /unknown tool/],
  ];
  for (const [r, re] of fails) {
    const err = await lucidCall("remember", {}, { env, fetchImpl: async () => r }).catch((e) => e);
    assert.match(err.message, re);
    assert.ok(!err.message.includes("ld-secret-token"));
  }
  await assert.rejects(lucidCall("remember", {}, { env: { APPDATA: os.tmpdir(), XDG_CONFIG_HOME: os.tmpdir() }, fetchImpl: async () => okReply }), /LUCID_URL/);
});

test("remember: off means no call at all; on sends the note; a dead server never throws", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return okReply; };
  const off = await remember({ config: normalize(base), text: "x", env, fetchImpl });
  assert.deepEqual([off.ok, off.skipped, calls], [false, true, 0]);
  const empty = await remember({ config: on, text: "  ", env, fetchImpl });
  assert.deepEqual([empty.skipped, calls], [true, 0]);

  const bodies = [];
  const r = await remember({ config: on, text: " a decision ", topic: "proj", origin: "u", saidBy: "user", env, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return okReply; } });
  assert.equal(r.ok, true);
  assert.deepEqual(bodies[0].params.arguments, { text: "a decision", topic: "proj", origin: "u", said_by: "user" });

  const dead = await remember({ config: on, text: "x", env, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual([dead.ok, dead.why], [false, "cannot reach lucid-dream: ECONNREFUSED"]);
});

test("agentEnv: the memory token never reaches the dev worker", () => {
  assert.equal(agentEnv({ LUCID_TOKEN: "ld-secret-token", LUCID_URL: "http://pc:7878/mcp" }, "/hooks").LUCID_TOKEN, undefined);
});

test("crew remember: skipped when off; saved to a real HTTP server when on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-lucid-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, ".claude"));
  const writeCfg = (extra) => fs.writeFileSync(path.join(dir, ".claude", "crew.json"), JSON.stringify({ ...base, ...extra }));
  const sink = () => ({ data: "", write(c) { this.data += c; return true; } });
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "saved" }], isError: false } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cwd = process.cwd();
  const saved = { LUCID_URL: process.env.LUCID_URL, LUCID_TOKEN: process.env.LUCID_TOKEN };
  try {
    process.chdir(dir);
    writeCfg({});
    let out = sink();
    assert.equal(await main(["remember", "a", "note"], { stdout: out, stderr: sink() }), 0);
    assert.match(out.data, /^skipped: /);
    assert.equal(got.length, 0);

    writeCfg({ lucid_dream: { remember: true } });
    process.env.LUCID_URL = `http://127.0.0.1:${server.address().port}/mcp`;
    process.env.LUCID_TOKEN = "ld-secret-token";
    out = sink();
    assert.equal(await main(["remember", "--topic", "proj", "--said-by", "user", "Use", "node", "20"], { stdout: out, stderr: sink() }), 0);
    assert.equal(out.data, "remembered\n");
    assert.equal(got[0].auth, "Bearer ld-secret-token");
    assert.deepEqual(got[0].body.params, { name: "remember", arguments: { text: "Use node 20", topic: "proj", said_by: "user" } });

    process.env.LUCID_URL = "http://127.0.0.1:1/mcp";
    out = sink();
    assert.equal(await main(["remember", "x"], { stdout: out, stderr: sink() }), 1);
    assert.match(out.data, /^not saved: /);
  } finally {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    server.close();
  }
});
