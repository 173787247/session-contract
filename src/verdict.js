import { findClaimFence, yamlDoubleQuoted } from "./fence.js";

/**
 * @param {object} claim
 * @param {string} claim.chainTip
 * @param {string} claim.contractSha256
 * @param {string} claim.outcome
 * @param {string} claim.compliance
 * @param {boolean} claim.suspectedSpin
 * @param {{ code: string, call_id?: string }[]} claim.reasons
 * @param {boolean | undefined} claim.accept
 * @param {unknown} claim.note
 */
export function formatClaimFence(claim) {
  const lines = [
    "```yaml",
    `session_contract: "0.1"`,
    "role: claim",
    `chain_tip: ${yamlDoubleQuoted(claim.chainTip)}`,
    `contract_sha256: ${yamlDoubleQuoted(claim.contractSha256)}`,
    `outcome: ${claim.outcome}`,
    `compliance: ${claim.compliance}`,
    `suspected_spin: ${claim.suspectedSpin}`,
  ];
  if (claim.reasons.length === 0) {
    lines.push("reasons: []");
  } else {
    lines.push("reasons:");
    for (const r of claim.reasons) {
      lines.push(`  - code: ${r.code}`);
      if (r.call_id !== undefined) lines.push(`    call_id: ${yamlDoubleQuoted(r.call_id)}`);
    }
  }
  if (claim.accept === true || claim.accept === false) {
    lines.push(`accept: ${claim.accept}`);
  }
  if (claim.note !== undefined) {
    lines.push(`note: ${yamlDoubleQuoted(String(claim.note))}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/**
 * @param {string | null} existing
 * @param {object} next
 * @param {string} next.chainTip
 * @param {string} next.contractSha256
 * @param {string} next.outcome
 * @param {string} next.compliance
 * @param {boolean} next.suspectedSpin
 * @param {{ code: string, call_id?: string }[]} next.reasons
 */
export function mergeVerdictMarkdown(existing, next) {
  let accept;
  let note;
  const fence = existing ? findClaimFence(existing) : null;
  if (fence?.parsed) {
    if (String(fence.parsed.chain_tip) === next.chainTip) {
      if (fence.parsed.accept === true || fence.parsed.accept === false) accept = fence.parsed.accept;
      if (fence.parsed.note !== undefined) note = fence.parsed.note;
    }
  }
  const block = formatClaimFence({ ...next, accept, note });
  if (!existing) {
    return `# session-contract verdict\n\n${block}\n`;
  }
  if (!fence) {
    const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
    return `${prefix}\n${block}\n`;
  }
  return existing.slice(0, fence.fence.start) + block + existing.slice(fence.fence.end);
}
