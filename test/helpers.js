import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../src/canonical.js";
import { formatNdjson } from "../src/evidence.js";
import { sealChain, sha256hex } from "../src/hash.js";
import { formatSidecar } from "../src/sidecar.js";

export const MINIMAL_CONTRACT = `# Example contract (minimal)

\`\`\`yaml
session_contract: "0.1"
goal: "bash node prints NODE_USE_ENV_PROXY=1 and the proxy URL, then stop"
writable_roots:
  - /home/rchua/GO
capabilities:
  fs.read: allow
  fs.write: allow
  exec: allow
  network: deny
redundant:
  n: 6
forbidden:
  - scan_home
\`\`\`
`;

export async function tempDir() {
  return mkdtemp(join(tmpdir(), "sc-"));
}

export function writePack(dir, { contract = MINIMAL_CONTRACT, events, verdict } = {}) {
  mkdirSync(dir, { recursive: true });
  const contractPath = join(dir, "contract.md");
  writeFileSync(contractPath, contract);
  const contractSha256 = sha256hex(readFileSync(contractPath));
  const cloned = events.map((e) => ({ ...e }));
  if (cloned[0]?.kind === "start") cloned[0].contract_sha256 = contractSha256;
  const sealed = sealChain(cloned);
  const ndjson = formatNdjson(sealed);
  writeFileSync(join(dir, "evidence.ndjson"), ndjson);
  writeFileSync(
    join(dir, "evidence.ndjson.sha256"),
    formatSidecar(sha256hex(Buffer.from(ndjson, "utf8")), sealed[sealed.length - 1].hash),
  );
  if (verdict !== undefined) writeFileSync(join(dir, "verdict.md"), verdict);
  return { dir, contractSha256, events: sealed };
}

export function startEvent(over = {}) {
  return {
    kind: "start",
    ts: "2026-08-20T01:00:00.000Z",
    contract_sha256: "0".repeat(64),
    harness: "dsh",
    session_id: "s1",
    ...over,
  };
}

export function toolCall(id, { cap = "exec", name, args = { cmd: "echo" }, write_paths = [], network, ts } = {}) {
  const ev = {
    kind: "tool_call",
    ts: ts ?? "2026-08-20T01:00:01.000Z",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": name ?? (cap === "exec" ? "bash" : cap),
    "gen_ai.tool.call.id": id,
    "session_contract.capability": cap,
    "session_contract.arguments_sha256": sha256hex(canonical(args)),
    "session_contract.write_paths": write_paths,
  };
  if (network) ev["session_contract.network"] = true;
  return ev;
}

export function toolResult(id, { name = "bash", digest = "aa", isError = false, ts } = {}) {
  const d = digest.length === 64 ? digest : sha256hex(digest);
  return {
    kind: "tool_result",
    ts: ts ?? "2026-08-20T01:00:02.000Z",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": name,
    "gen_ai.tool.call.id": id,
    "session_contract.result_sha256": sha256hex(canonical({ isError, digest: d })),
  };
}

export function endEvent(stop_reason = "user") {
  return { kind: "end", ts: "2026-08-20T01:00:10.000Z", stop_reason };
}
