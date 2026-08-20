import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MINIMAL_CONTRACT, endEvent, startEvent, tempDir, toolCall, toolResult, writePack } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "session-contract.js");

function run(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("check", () => {
  it("exit 2 when required files are missing; verdict.md absence is not an error", async () => {
    const dir = await tempDir();
    const r = run(["check", dir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing required file/);
  });

  it("exit 2 when pack is not a directory", async () => {
    const dir = await tempDir();
    const file = join(dir, "x");
    writeFileSync(file, "nope");
    const r = run(["check", file]);
    assert.equal(r.status, 2);
  });

  it("truncated pack: exit 0, incomplete.truncated, creates verdict.md", async () => {
    const dir = await tempDir();
    writePack(dir, {
      events: [startEvent(), toolCall("c1"), toolResult("c1")],
    });
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^outcome=incomplete compliance=compliant suspected_spin=false verdict=/);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    assert.match(v, /code: incomplete\.truncated/);
    assert.doesNotMatch(v, /incomplete\.goal/);
    assert.doesNotMatch(v, /^accept:/m);
  });

  it("end present: incomplete.goal not truncated", async () => {
    const dir = await tempDir();
    writePack(dir, {
      events: [startEvent(), toolCall("c1"), toolResult("c1"), endEvent("user")],
    });
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    assert.match(v, /code: incomplete\.goal/);
    assert.doesNotMatch(v, /incomplete\.truncated/);
  });

  it("StopFailure-shaped pack: start then end error, no tools → incomplete.goal", async () => {
    const dir = await tempDir();
    writePack(dir, {
      events: [startEvent(), endEvent("error")],
    });
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^outcome=incomplete compliance=compliant suspected_spin=false verdict=/);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    assert.match(v, /code: incomplete\.goal/);
    assert.doesNotMatch(v, /incomplete\.truncated/);
  });

  it("overreach.network and capability", async () => {
    const dir = await tempDir();
    writePack(dir, {
      events: [
        startEvent(),
        toolCall("c9", { cap: "network", name: "web_search", network: true, args: { q: "x" } }),
        toolResult("c9", { name: "web_search" }),
        endEvent(),
      ],
    });
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /compliance=overreach/);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    assert.match(v, /overreach\.capability/);
    assert.match(v, /overreach\.network/);
    assert.match(v, /call_id: "c9"/);
  });

  it("C2: event after end is invalid, does not write verdict", async () => {
    const dir = await tempDir();
    writePack(dir, {
      events: [startEvent(), endEvent(), toolCall("late")],
    });
    const before = existsSync(join(dir, "verdict.md"));
    const r = run(["check", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /event after end/);
    assert.equal(existsSync(join(dir, "verdict.md")), before);
  });

  it("C2: unknown kind is invalid", async () => {
    const dir = await tempDir();
    writePack(dir, {
      events: [startEvent(), { kind: "note", ts: "2026-08-20T01:00:01.000Z" }],
    });
    writeFileSync(join(dir, "verdict.md"), "keep me\n");
    const r = run(["check", dir]);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(join(dir, "verdict.md"), "utf8"), "keep me\n");
  });

  it("C1: rewrites only the claim fence; prose fences stay", async () => {
    const dir = await tempDir();
    const { events } = writePack(dir, {
      events: [startEvent(), endEvent()],
    });
    const tip = events[events.length - 1].hash;
    writeFileSync(
      join(dir, "verdict.md"),
      [
        "# notes",
        "",
        "```js",
        "console.log('not a claim')",
        "```",
        "",
        "```yaml",
        'session_contract: "0.1"',
        "role: claim",
        `chain_tip: "${tip}"`,
        `contract_sha256: "${"0".repeat(64)}"`,
        "outcome: incomplete",
        "compliance: compliant",
        "suspected_spin: false",
        "reasons: []",
        "accept: true",
        'note: "human said so"',
        "```",
        "",
      ].join("\n"),
    );
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    assert.match(v, /console\.log\('not a claim'\)/);
    assert.match(v, /accept: true/);
    assert.match(v, /human said so/);
  });

  it("C1: corrupt claim yaml is rebuilt and accept is dropped", async () => {
    const dir = await tempDir();
    writePack(dir, { events: [startEvent(), endEvent()] });
    writeFileSync(
      join(dir, "verdict.md"),
      ["```yaml", 'session_contract: "0.1"', "role: claim", "this: [is: broken", "accept: true", "```", ""].join("\n"),
    );
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    assert.doesNotMatch(v, /accept:/);
    assert.match(v, /role: claim/);
  });

  it("C6: one spin reason; call_id is the first pair in the streak", async () => {
    const dir = await tempDir();
    const args = { cmd: "same" };
    const events = [startEvent()];
    for (let i = 1; i <= 6; i++) {
      events.push(toolCall(`c${i}`, { args }));
      events.push(toolResult(`c${i}`, { digest: "same-body" }));
    }
    events.push(endEvent());
    writePack(dir, { events });
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /suspected_spin=true/);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    const spins = v.match(/code: spin\.redundant_streak/g) || [];
    assert.equal(spins.length, 1);
    assert.match(v, /call_id: "c1"/);
  });

  it("C6: dangling tool_call between pairs resets the streak", async () => {
    const dir = await tempDir();
    const contract = MINIMAL_CONTRACT.replace("n: 6", "n: 2");
    const args = { cmd: "same" };
    writePack(dir, {
      contract,
      events: [
        startEvent(),
        toolCall("a1", { args }),
        toolResult("a1", { digest: "same-body" }),
        toolCall("dangling", { args }),
        toolCall("b1", { args }),
        toolResult("b1", { digest: "same-body" }),
        endEvent(),
      ],
    });
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /suspected_spin=false/);
    const v = readFileSync(join(dir, "verdict.md"), "utf8");
    assert.doesNotMatch(v, /spin\.redundant_streak/);
    assert.match(v, /unmatched_tool_call/);
    assert.match(v, /call_id: "dangling"/);
  });

  it("goal string with * is not a yaml alias", async () => {
    const dir = await tempDir();
    writePack(dir, {
      contract: MINIMAL_CONTRACT.replace(
        'goal: "bash node prints NODE_USE_ENV_PROXY=1 and the proxy URL, then stop"',
        'goal: "print a * b then stop"',
      ),
      events: [startEvent(), endEvent()],
    });
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
  });

  it("drops accept when chain_tip changes", async () => {
    const dir = await tempDir();
    writePack(dir, { events: [startEvent(), endEvent()] });
    writeFileSync(
      join(dir, "verdict.md"),
      [
        "```yaml",
        'session_contract: "0.1"',
        "role: claim",
        `chain_tip: "${"a".repeat(64)}"`,
        `contract_sha256: "${"b".repeat(64)}"`,
        "outcome: incomplete",
        "compliance: compliant",
        "suspected_spin: false",
        "reasons: []",
        "accept: true",
        "```",
        "",
      ].join("\n"),
    );
    const r = run(["check", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(readFileSync(join(dir, "verdict.md"), "utf8"), /accept:/);
  });
});
