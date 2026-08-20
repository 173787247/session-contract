import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MINIMAL_CONTRACT, tempDir } from "./helpers.js";
import { zstdCompressSync } from "node:zlib";
import { decodeSessionBytes } from "../src/dsh-map.js";
import { zipDeflateBit3, zipStore } from "../src/zip.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "session-contract.js");
const exampleContract = join(root, "examples", "minimal", "contract.md");

function run(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
}

function sessionJsonl({ cwd = "/home/rchua/GO", tools = [] } = {}) {
  const header = {
    type: "session",
    version: 0,
    id: "sess-1",
    createdAt: 1_755_000_000_000,
    cwd,
  };
  const lines = [JSON.stringify(header)];
  let seq = 0;
  for (const t of tools) {
    lines.push(
      JSON.stringify({
        type: "tool/call",
        seq: seq++,
        time: 1_755_000_001_000,
        data: { name: t.name, callId: t.id, arguments: JSON.stringify(t.args ?? {}) },
      }),
    );
    if (t.result !== false) {
      lines.push(
        JSON.stringify({
          type: "tool/result",
          seq: seq++,
          time: 1_755_000_002_000,
          data: {
            message: {
              source: { callId: t.id },
              content: [
                {
                  type: "tool-result",
                  toolCallId: t.id,
                  isError: Boolean(t.error),
                  content: [{ type: "text", text: t.body ?? "ok" }],
                },
              ],
            },
          },
        }),
      );
    }
  }
  if (tEnd(tools)) {
    lines.push(
      JSON.stringify({
        type: "turn/end",
        seq: seq++,
        time: 1_755_000_010_000,
        data: { turn: 1, reason: tools.endReason ?? { kind: "aborted", reason: { kind: "user" } } },
      }),
    );
  }
  return lines.join("\n") + "\n";
}

function tEnd(tools) {
  return tools.end !== false;
}

describe("adapt dsh", () => {
  it("C4: refuses to overwrite existing evidence.ndjson", async () => {
    const dir = await tempDir();
    mkdirSync(join(dir, "pack"));
    writeFileSync(join(dir, "pack", "evidence.ndjson"), "{}\n");
    writeFileSync(join(dir, "in.jsonl"), sessionJsonl());
    const r = run(["adapt", "dsh", join(dir, "in.jsonl"), "--out", join(dir, "pack"), "--contract", exampleContract]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
  });

  it("C4: both contracts present → uses --out bytes", async () => {
    const dir = await tempDir();
    const pack = join(dir, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "contract.md"), MINIMAL_CONTRACT);
    writeFileSync(join(dir, "other.md"), MINIMAL_CONTRACT.replace("then stop", "THEN STOP"));
    writeFileSync(join(dir, "in.jsonl"), sessionJsonl({ tools: [{ name: "bash", id: "b1", args: { command: "true" } }] }));
    const r = run(["adapt", "dsh", join(dir, "in.jsonl"), "--out", pack, "--contract", join(dir, "other.md")]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(pack, "contract.md"), "utf8"), MINIMAL_CONTRACT);
    assert.notEqual(readFileSync(join(pack, "contract.md"), "utf8"), readFileSync(join(dir, "other.md"), "utf8"));
  });

  it("omits todo_write; maps bash; end from aborted user; check round-trip", async () => {
    const dir = await tempDir();
    const jsonl = sessionJsonl({
      tools: [
        { name: "todo_write", id: "t1", args: { todos: [] } },
        { name: "bash", id: "b1", args: { command: "node -e process.env" } },
      ],
    });
    const zipPath = join(dir, "export.zip");
    writeFileSync(zipPath, zipStore({ "session.jsonl": jsonl }));
    const pack = join(dir, "pack");
    const a = run(["adapt", "dsh", zipPath, "--out", pack, "--contract", exampleContract]);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /^out=/);
    const nd = readFileSync(join(pack, "evidence.ndjson"), "utf8");
    assert.doesNotMatch(nd, /todo_write/);
    assert.match(nd, /"kind":"tool_call"/);
    assert.match(nd, /"gen_ai.tool.name":"bash"/);
    assert.match(nd, /"stop_reason":"user"/);
    const c = run(["check", pack]);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /outcome=incomplete compliance=compliant/);
  });

  it("late tool_result after turn/end blocks end", async () => {
    const dir = await tempDir();
    const header = JSON.stringify({ type: "session", id: "s", createdAt: 1000, cwd: "/home/rchua/GO" });
    const call = JSON.stringify({
      type: "tool/call",
      seq: 0,
      time: 2000,
      data: { name: "bash", callId: "b1", arguments: "{}" },
    });
    const tend = JSON.stringify({
      type: "turn/end",
      seq: 1,
      time: 3000,
      data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } },
    });
    const result = JSON.stringify({
      type: "tool/result",
      seq: 2,
      time: 4000,
      data: { message: { source: { callId: "b1" }, content: [{ type: "tool-result", toolCallId: "b1", content: [] }] } },
    });
    writeFileSync(join(dir, "in.jsonl"), [header, call, tend, result].join("\n") + "\n");
    const pack = join(dir, "pack");
    const a = run(["adapt", "dsh", join(dir, "in.jsonl"), "--out", pack, "--contract", exampleContract]);
    assert.equal(a.status, 0, a.stderr);
    const nd = readFileSync(join(pack, "evidence.ndjson"), "utf8");
    assert.doesNotMatch(nd, /"kind":"end"/);
    const c = run(["check", pack]);
    assert.equal(c.status, 0, c.stderr);
    assert.match(readFileSync(join(pack, "verdict.md"), "utf8"), /incomplete\.truncated/);
  });

  it("unknown tool falls back to exec", async () => {
    const dir = await tempDir();
    writeFileSync(
      join(dir, "in.jsonl"),
      sessionJsonl({ tools: [{ name: "mystery_tool", id: "m1" }] }),
    );
    const pack = join(dir, "pack");
    const a = run(["adapt", "dsh", join(dir, "in.jsonl"), "--out", pack, "--contract", exampleContract]);
    assert.equal(a.status, 0, a.stderr);
    assert.match(readFileSync(join(pack, "evidence.ndjson"), "utf8"), /"session_contract.capability":"exec"/);
  });

  it("P1: deflate+bit3 zip (fflate /export layout) adapts", async () => {
    const dir = await tempDir();
    const jsonl = sessionJsonl({ tools: [{ name: "bash", id: "b1", args: { command: "true" } }] });
    const zipPath = join(dir, "export.zip");
    const zip = zipDeflateBit3({ "session.jsonl": jsonl });
    assert.equal(zip.readUInt16LE(6), 0x0008);
    assert.equal(zip.readUInt32LE(18), 0);
    writeFileSync(zipPath, zip);
    const pack = join(dir, "pack");
    const a = run(["adapt", "dsh", zipPath, "--out", pack, "--contract", exampleContract]);
    assert.equal(a.status, 0, a.stderr);
    assert.match(readFileSync(join(pack, "evidence.ndjson"), "utf8"), /"gen_ai.tool.name":"bash"/);
  });

  it("omits get_goal and does not mint unknown call ids", async () => {
    const dir = await tempDir();
    const header = JSON.stringify({ type: "session", id: "s", createdAt: 1000, cwd: "/home/rchua/GO" });
    const call = JSON.stringify({
      type: "tool/call",
      seq: 0,
      time: 2000,
      data: { name: "get_goal", callId: "g1", arguments: "{}" },
    });
    const orphan = JSON.stringify({
      type: "tool/result",
      seq: 1,
      time: 3000,
      data: { message: { content: [{ type: "tool-result", content: [] }] } },
    });
    writeFileSync(join(dir, "in.jsonl"), [header, call, orphan].join("\n") + "\n");
    const pack = join(dir, "pack");
    const a = run(["adapt", "dsh", join(dir, "in.jsonl"), "--out", pack, "--contract", exampleContract]);
    assert.equal(a.status, 0, a.stderr);
    const nd = readFileSync(join(pack, "evidence.ndjson"), "utf8");
    assert.doesNotMatch(nd, /get_goal/);
    assert.doesNotMatch(nd, /"unknown"/);
  });

  it("bad createdAt is exit 1 not 2", async () => {
    const dir = await tempDir();
    writeFileSync(
      join(dir, "in.jsonl"),
      JSON.stringify({ type: "session", id: "s", createdAt: "nope" }) + "\n",
    );
    const a = run(["adapt", "dsh", join(dir, "in.jsonl"), "--out", join(dir, "pack"), "--contract", exampleContract]);
    assert.equal(a.status, 1, a.stderr);
  });

  it("concatenated zstd frames (dsh on-disk layout) all decode", () => {
    const a = JSON.stringify({ type: "session", id: "s", createdAt: 1, cwd: "/home/rchua/GO" }) + "\n";
    const b = JSON.stringify({
      type: "tool/call",
      seq: 0,
      time: 2,
      data: { name: "bash", callId: "b1", arguments: "{}" },
    }) + "\n";
    const framed = Buffer.concat([zstdCompressSync(Buffer.from(a)), zstdCompressSync(Buffer.from(b))]);
    const text = decodeSessionBytes(framed);
    assert.match(text, /tool\/call/);
    assert.match(text, /"type":"session"/);
  });
});
