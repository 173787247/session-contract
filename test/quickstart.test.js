import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "session-contract.js");
const pack = join(root, "examples", "quickstart", "pack");

describe("examples/quickstart pack", () => {
  it("committed pack checks with the expected claim", () => {
    const r = spawnSync(process.execPath, [bin, "check", pack], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /outcome=incomplete compliance=overreach suspected_spin=false/);
    const v = readFileSync(join(pack, "verdict.md"), "utf8");
    assert.match(v, /overreach\.capability/);
    assert.match(v, /overreach\.network/);
    assert.match(v, /call_id: "call_demo_3"/);
    assert.match(v, /incomplete\.goal/);
    assert.doesNotMatch(v, /incomplete\.truncated/);
    const reasons = v.match(/code: /g) || [];
    assert.equal(reasons.length, 3);
  });
});
