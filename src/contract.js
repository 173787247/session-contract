import { ALLOW_DENY, CliError } from "./errors.js";
import { findContractFence } from "./fence.js";
import { isAbsolutePath } from "./paths.js";

/**
 * @param {string} markdown
 */
export function parseContractMarkdown(markdown) {
  const { parsed } = findContractFence(markdown);
  return interpretContract(parsed);
}

/**
 * @param {Record<string, unknown>} y
 */
export function interpretContract(y) {
  if (String(y.session_contract) !== "0.1") {
    throw new CliError(1, "contract: session_contract must be \"0.1\"");
  }
  if (typeof y.goal !== "string" || y.goal.length === 0) {
    throw new CliError(1, "contract: goal is required");
  }
  if (!Array.isArray(y.writable_roots)) {
    throw new CliError(1, "contract: writable_roots is required");
  }
  const writable_roots = y.writable_roots.map((r) => {
    if (typeof r !== "string") throw new CliError(1, "contract: writable_roots entries must be strings");
    if (!isAbsolutePath(r)) throw new CliError(1, "contract: writable_roots entries MUST be absolute");
    return r;
  });
  if (y.capabilities === null || typeof y.capabilities !== "object" || Array.isArray(y.capabilities)) {
    throw new CliError(1, "contract: capabilities is required");
  }
  const capIn = /** @type {Record<string, unknown>} */ (y.capabilities);
  /** @type {Record<string, "allow" | "deny">} */
  const capabilities = {
    "fs.read": allowDeny(capIn["fs.read"], "fs.read"),
    "fs.write": allowDeny(capIn["fs.write"], "fs.write"),
    exec: allowDeny(capIn.exec, "exec"),
    network: allowDeny(capIn.network, "network"),
  };
  const redundant = y.redundant;
  if (redundant === null || typeof redundant !== "object" || Array.isArray(redundant)) {
    throw new CliError(1, "contract: redundant.n is required");
  }
  const n = /** @type {Record<string, unknown>} */ (redundant).n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 2) {
    throw new CliError(1, "contract: redundant.n must be an integer >= 2");
  }
  return { goal: y.goal, writable_roots, capabilities, n };
}

/**
 * @param {unknown} v
 * @param {string} key
 * @returns {"allow" | "deny"}
 */
function allowDeny(v, key) {
  if (v === undefined) return "deny";
  if (typeof v === "string" && ALLOW_DENY.has(v)) return /** @type {"allow" | "deny"} */ (v);
  throw new CliError(1, `contract: capabilities.${key} must be allow | deny`);
}
