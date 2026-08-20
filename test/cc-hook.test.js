import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { plantStaleLock } from "../src/cc-lock.js";
import { mergeSettings, hooksFragment } from "../src/cc-init.js";
import { digestBody, resultSha256 } from "../src/cc-map.js";
import { claudeSpawnOpts, cmdQuote, defaultPackDir, resolveClaudeBin } from "../src/cc-run.js";
import { healTornNdjson } from "../src/cc-writer.js";
import { parseSidecar } from "../src/sidecar.js";
import { sha256hex } from "../src/hash.js";
import { MINIMAL_CONTRACT, tempDir } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "session-contract.js");

function run(args, { cwd, env, input } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
}

function payload(event, extra = {}) {
  return { hook_event_name: event, session_id: "s-cc", cwd: "/tmp/proj", ...extra };
}

function hook(pack, event, extra = {}) {
  return run(["cc-hook", event], {
    env: { SESSION_CONTRACT_PACK: pack },
    input: JSON.stringify(payload(event, extra)),
  });
}

function eventsOf(pack) {
  const text = readFileSync(join(pack, "evidence.ndjson"), "utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => JSON.parse(l));
}

async function makePack() {
  const dir = await tempDir();
  writeFileSync(join(dir, "contract.md"), MINIMAL_CONTRACT);
  return dir;
}

function spawnHook(pack, event, extra = {}) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [bin, "cc-hook", event], {
      env: { ...process.env, SESSION_CONTRACT_PACK: pack },
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.on("close", (code) => resolveP({ code, stderr, stdout }));
    child.stdin.end(JSON.stringify(payload(event, extra)));
  });
}

describe("cc-hook D9", () => {
  it("1. SessionStart writes one start line and sidecar", async () => {
    const pack = await makePack();
    const r = hook(pack, "SessionStart", { source: "startup", session_title: "t" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    const ev = eventsOf(pack);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, "start");
    assert.equal(ev[0].harness, "claude-code");
    assert.equal(ev[0].session_id, "s-cc");
    assert.equal(ev[0].source, "startup");
    const sc = parseSidecar(readFileSync(join(pack, "evidence.ndjson.sha256"), "utf8"));
    const bytes = readFileSync(join(pack, "evidence.ndjson"));
    assert.equal(sc.fileHex, sha256hex(bytes));
    assert.equal(sc.chainTip, ev[0].hash);
  });

  it("2. missing contract.md → no evidence, exit 1", async () => {
    const pack = await tempDir();
    const r = hook(pack, "SessionStart");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing contract.md/);
    assert.equal(existsSync(join(pack, "evidence.ndjson")), false);
  });

  it("3. PreToolUse then PostToolUse pair on the same tool_use_id", async () => {
    const pack = await makePack();
    const pre = hook(pack, "PreToolUse", {
      tool_name: "Read",
      tool_use_id: "c1",
      tool_input: { file_path: "/tmp/proj/a.txt" },
    });
    assert.equal(pre.status, 0, pre.stderr);
    const post = hook(pack, "PostToolUse", {
      tool_name: "Read",
      tool_use_id: "c1",
      tool_input: { file_path: "/tmp/proj/a.txt" },
      tool_response: { content: "hi" },
    });
    assert.equal(post.status, 0, post.stderr);
    const ev = eventsOf(pack);
    assert.equal(ev.map((e) => e.kind).join(","), "start,tool_call,tool_result");
    assert.equal(ev[1]["gen_ai.tool.call.id"], "c1");
    assert.equal(ev[1]["session_contract.capability"], "fs.read");
    assert.deepEqual(ev[1]["session_contract.write_paths"], []);
    assert.equal(ev[2]["gen_ai.tool.call.id"], "c1");
    assert.equal(ev[2]["session_contract.result_sha256"], resultSha256(false, digestBody({ content: "hi" })));
  });

  it("4. PermissionDenied isError; abandoned PreToolUse stays unmatched", async () => {
    const pack = await makePack();
    assert.equal(
      hook(pack, "PreToolUse", { tool_name: "Write", tool_use_id: "deny1", tool_input: { file_path: "/tmp/proj/x" } }).status,
      0,
    );
    const denied = hook(pack, "PermissionDenied", {
      tool_name: "Write",
      tool_use_id: "deny1",
      reason: "not allowed",
    });
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(
      hook(pack, "PreToolUse", { tool_name: "Bash", tool_use_id: "orphan", tool_input: { command: "true" } }).status,
      0,
    );
    const ev = eventsOf(pack);
    const deniedResult = ev.find((e) => e.kind === "tool_result" && e["gen_ai.tool.call.id"] === "deny1");
    assert.equal(deniedResult["session_contract.result_sha256"], resultSha256(true, digestBody("not allowed")));
    const check = run(["check", pack]);
    assert.equal(check.status, 0, check.stderr);
    const verdict = readFileSync(join(pack, "verdict.md"), "utf8");
    assert.match(verdict, /warning.unmatched_tool_call/);
    assert.match(verdict, /orphan/);
  });

  it("5. concurrent PostToolUse N>=4 serializes into one valid chain", { timeout: 20_000 }, async () => {
    const pack = await makePack();
    const n = 4;
    const jobs = [];
    for (let i = 0; i < n; i++) {
      jobs.push(
        spawnHook(pack, "PostToolUse", {
          tool_name: "Bash",
          tool_use_id: `p${i}`,
          tool_input: { command: `echo ${i}` },
          tool_response: `out-${i}`,
        }),
      );
    }
    const results = await Promise.all(jobs);
    for (const r of results) {
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
    const ev = eventsOf(pack);
    assert.equal(ev.length, 1 + 2 * n);
    assert.equal(ev[0].kind, "start");
    assert.equal(ev.filter((e) => e.kind === "tool_call").length, n);
    assert.equal(ev.filter((e) => e.kind === "tool_result").length, n);
    const check = run(["check", pack]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /outcome=incomplete/);
  });

  it("6. crash heal rewrites a missing sidecar", async () => {
    const pack = await makePack();
    assert.equal(hook(pack, "SessionStart").status, 0);
    unlinkSync(join(pack, "evidence.ndjson.sha256"));
    const r = hook(pack, "PreToolUse", { tool_name: "Bash", tool_use_id: "h1", tool_input: {} });
    assert.equal(r.status, 0, r.stderr);
    const sc = parseSidecar(readFileSync(join(pack, "evidence.ndjson.sha256"), "utf8"));
    const bytes = readFileSync(join(pack, "evidence.ndjson"));
    assert.equal(sc.fileHex, sha256hex(bytes));
    assert.equal(run(["check", pack]).status, 0);
  });

  it("7. refuse append after end: log unchanged, exit 0", async () => {
    const pack = await makePack();
    assert.equal(hook(pack, "SessionStart").status, 0);
    assert.equal(hook(pack, "SessionEnd").status, 0);
    const before = readFileSync(join(pack, "evidence.ndjson"));
    const r = hook(pack, "PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "late",
      tool_input: {},
      tool_response: "x",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /refused: log already ended/);
    assert.equal(r.stdout, "");
    assert.deepEqual(readFileSync(join(pack, "evidence.ndjson")), before);
  });

  it("8. stale lock (mtime > 60s) is stolen", async () => {
    const pack = await makePack();
    plantStaleLock(pack, 61_000);
    const r = hook(pack, "SessionStart");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(eventsOf(pack)[0].kind, "start");
  });

  it("11. torn tail is truncated; chain stays valid", async () => {
    const pack = await makePack();
    assert.equal(hook(pack, "SessionStart").status, 0);
    const good = readFileSync(join(pack, "evidence.ndjson"));
    writeFileSync(join(pack, "evidence.ndjson"), Buffer.concat([good, Buffer.from('{"kind":"tool_call","ts":"')]));
    const r = hook(pack, "PreToolUse", { tool_name: "Bash", tool_use_id: "after-tear", tool_input: {} });
    assert.equal(r.status, 0, r.stderr);
    const ev = eventsOf(pack);
    assert.equal(ev[0].kind, "start");
    assert.equal(ev[1]["gen_ai.tool.call.id"], "after-tear");
    assert.equal(run(["check", pack]).status, 0);
  });

  it("12. SessionStart is no-op when start already exists", async () => {
    const pack = await makePack();
    assert.equal(
      hook(pack, "PreToolUse", { tool_name: "Bash", tool_use_id: "first", tool_input: {} }).status,
      0,
    );
    const before = readFileSync(join(pack, "evidence.ndjson"));
    const r = hook(pack, "SessionStart", { source: "startup" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.deepEqual(readFileSync(join(pack, "evidence.ndjson")), before);
    assert.equal(eventsOf(pack).filter((e) => e.kind === "start").length, 1);
  });

  it("never exits 2; omit and argv mismatch", async () => {
    const pack = await makePack();
    const missingArg = run(["cc-hook"]);
    assert.equal(missingArg.status, 1);
    const badJson = run(["cc-hook", "SessionStart"], { env: { SESSION_CONTRACT_PACK: pack }, input: "nope" });
    assert.equal(badJson.status, 1);
    const mismatch = hook(pack, "SessionStart");
    const mm = run(["cc-hook", "PreToolUse"], {
      env: { SESSION_CONTRACT_PACK: pack },
      input: JSON.stringify(payload("SessionStart")),
    });
    assert.equal(mm.status, 1);
    assert.equal(mismatch.status, 0);
    const omit = hook(pack, "PreToolUse", { tool_name: "TodoWrite", tool_use_id: "t1", tool_input: {} });
    assert.equal(omit.status, 0);
    assert.equal(eventsOf(pack).length, 1);
    const sub = hook(pack, "PreToolUse", {
      agent_id: "sub-1",
      tool_name: "Bash",
      tool_use_id: "t2",
      tool_input: {},
    });
    assert.equal(sub.status, 0);
    assert.equal(eventsOf(pack).length, 1);
  });
});

describe("cc-init", () => {
  it("9. --print JSON has seven events, node+abs bin, no Stop", () => {
    const r = run(["cc-init", "--print"]);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    const names = ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "SessionEnd", "StopFailure"];
    assert.deepEqual(Object.keys(json.hooks).sort(), [...names].sort());
    assert.equal(json.hooks.Stop, undefined);
    for (const ev of names) {
      const entry = json.hooks[ev][0];
      assert.equal(entry.matcher, "");
      const h = entry.hooks[0];
      assert.equal(h.command, "node");
      assert.equal(h.args[0], resolve(bin));
      assert.equal(h.args[1], "cc-hook");
      assert.equal(h.args[2], ev);
    }
  });

  it("merge is idempotent and keeps other hooks and top-level keys", async () => {
    const cwd = await tempDir();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash"] },
        env: { FOO: "1" },
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
        },
      }),
    );
    const first = run(["cc-init", "--write", "project"], { cwd });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "");
    const second = run(["cc-init", "--write", "project"], { cwd });
    assert.equal(second.status, 0, second.stderr);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Bash"] });
    assert.deepEqual(settings.env, { FOO: "1" });
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "echo");
    assert.equal(settings.hooks.SessionStart.length, 1);
    const mergedAgain = mergeSettings(settings, hooksFragment());
    assert.equal(mergedAgain.hooks.PreToolUse.length, 2);
    assert.equal(mergedAgain.hooks.SessionStart.length, 1);
  });
});

describe("cc-run", () => {
  it("10. fake claude; second run does not overwrite pack/contract.md", async () => {
    const cwd = await tempDir();
    const contractA = join(cwd, "a.md");
    const contractB = join(cwd, "b.md");
    writeFileSync(contractA, MINIMAL_CONTRACT);
    writeFileSync(contractB, `${MINIMAL_CONTRACT}\n# other\n`);
    const pack = join(cwd, "pack");
    const first = run(["cc-run", "--contract", contractA, "--pack", pack, "--", "-e", "process.exit(7)"], {
      cwd,
      env: { SESSION_CONTRACT_CLAUDE: process.execPath },
    });
    assert.equal(first.status, 7, first.stderr);
    assert.equal(first.stdout, "");
    assert.match(first.stderr, /^pack=/);
    const original = readFileSync(join(pack, "contract.md"));
    const second = run(["cc-run", "--contract", contractB, "--pack", pack, "--", "-e", "process.exit(0)"], {
      cwd,
      env: { SESSION_CONTRACT_CLAUDE: process.execPath },
    });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(join(pack, "contract.md")), original);
  });

  it("default pack name is UTC second + 4 hex", () => {
    const now = new Date("2026-08-20T04:17:09.123Z");
    const dir = defaultPackDir(now, "ab0f");
    assert.match(dir.replaceAll("\\", "/"), /\.session-contract\/packs\/20260820T041709Z-ab0f$/);
  });

  it("cmdQuote preserves spaces and inner quotes for cmd.exe", () => {
    assert.equal(cmdQuote("hello world"), `"hello world"`);
    assert.equal(cmdQuote('say "hi"'), `"say ""hi"""`);
    assert.equal(cmdQuote("100%"), "100%%");
  });

  it("resolves the Windows npm shim named claude.cmd", async () => {
    const dir = await tempDir();
    const shim = join(dir, "claude.cmd");
    writeFileSync(shim, "@echo off\n");
    const resolved = resolveClaudeBin("claude", { PATH: dir, Path: dir });
    if (process.platform === "win32") {
      assert.equal(resolved, shim);
      const launched = claudeSpawnOpts(resolved, ["-p", "hello world"], { ComSpec: "cmd.exe" });
      assert.equal(launched.opts.shell, false);
      assert.equal(launched.opts.windowsVerbatimArguments, true);
      assert.deepEqual(launched.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(launched.args[3], /"hello world"/);
    }
    assert.equal(claudeSpawnOpts(process.execPath, [], {}).opts.shell, false);
  });

  it("Windows .cmd shim: exit code 7 and a spaced argv survive cmd.exe", { skip: process.platform !== "win32" }, async () => {
    const cwd = await tempDir();
    const contract = join(cwd, "c.md");
    writeFileSync(contract, MINIMAL_CONTRACT);
    const shim = join(cwd, "claude.cmd");
    writeFileSync(shim, "@echo off\r\necho ARG1=%1\r\nexit /b 7\r\n");
    const pack = join(cwd, "pack");
    const r = run(["cc-run", "--contract", contract, "--pack", pack, "--", "hello world"], {
      cwd,
      env: { SESSION_CONTRACT_CLAUDE: shim },
    });
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.stdout, /hello world/);
  });
});

describe("healTornNdjson", () => {
  it("drops a non-LF tail and an invalid last JSON line", () => {
    const start = '{"kind":"start"}\n';
    assert.equal(healTornNdjson(Buffer.from(`${start}{"kind":"tool_call"`)), start);
    assert.equal(healTornNdjson(Buffer.from(`${start}not-json\n`)), start);
  });
});
