import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseContractMarkdown } from "./contract.js";
import { CliError } from "./errors.js";
import { parseEvidenceNdjson, validateChain } from "./evidence.js";
import { sha256hex } from "./hash.js";
import { judge } from "./judge.js";
import { parseSidecar } from "./sidecar.js";
import { mergeVerdictMarkdown } from "./verdict.js";

/**
 * @param {string} pack
 */
export function checkPack(pack) {
  const dir = resolve(pack);
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new CliError(2, `pack directory not found: ${dir}`);
  }
  if (!st.isDirectory()) throw new CliError(2, `not a directory: ${dir}`);

  const contractPath = join(dir, "contract.md");
  const evidencePath = join(dir, "evidence.ndjson");
  const sidecarPath = join(dir, "evidence.ndjson.sha256");
  const verdictPath = join(dir, "verdict.md");

  for (const p of [contractPath, evidencePath, sidecarPath]) {
    if (!existsSync(p)) throw new CliError(2, `missing required file: ${p}`);
  }

  let contractBytes;
  let evidenceBytes;
  let sidecarText;
  try {
    contractBytes = readFileSync(contractPath);
    evidenceBytes = readFileSync(evidencePath);
    sidecarText = readFileSync(sidecarPath, "utf8");
  } catch (e) {
    throw new CliError(2, `read failed: ${e.message}`);
  }

  const sidecar = parseSidecar(sidecarText);
  const fileHex = sha256hex(evidenceBytes);
  if (fileHex !== sidecar.fileHex) {
    throw new CliError(1, "sidecar file hash mismatch");
  }

  const contractSha256 = sha256hex(contractBytes);
  const contract = parseContractMarkdown(contractBytes.toString("utf8"));
  const events = parseEvidenceNdjson(evidenceBytes.toString("utf8"));
  const { chainTip, hasEnd } = validateChain(events);
  if (chainTip !== sidecar.chainTip) {
    throw new CliError(1, "sidecar chain_tip mismatch");
  }
  const start = events[0];
  if (start.contract_sha256 !== contractSha256) {
    throw new CliError(1, "start.contract_sha256 does not match on-disk contract.md");
  }

  const claim = judge(contract, events, hasEnd);
  let existing = null;
  if (existsSync(verdictPath)) {
    existing = readFileSync(verdictPath, "utf8");
  }
  const merged = mergeVerdictMarkdown(existing, {
    chainTip,
    contractSha256,
    outcome: claim.outcome,
    compliance: claim.compliance,
    suspectedSpin: claim.suspected_spin,
    reasons: claim.reasons,
  });
  writeFileSync(verdictPath, merged.endsWith("\n") ? merged : `${merged}\n`);

  return {
    outcome: claim.outcome,
    compliance: claim.compliance,
    suspected_spin: claim.suspected_spin,
    verdict: verdictPath,
  };
}
