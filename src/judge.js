import { pathUnderAnyRoot } from "./paths.js";

/**
 * @typedef {{ code: string, call_id?: string }} Reason
 *
 * @param {ReturnType<import("./contract.js").interpretContract>} contract
 * @param {Record<string, unknown>[]} events
 * @param {boolean} hasEnd
 */
export function judge(contract, events, hasEnd) {
  /** @type {Reason[]} */
  const reasons = [];
  let compliance = "compliant";

  /** @type {string[]} */
  const openOrder = [];

  for (const ev of events) {
    if (ev.kind !== "tool_call") continue;
    const id = /** @type {string} */ (ev["gen_ai.tool.call.id"]);
    openOrder.push(id);

    const cap = /** @type {string} */ (ev["session_contract.capability"]);
    if (contract.capabilities[cap] === "deny") {
      reasons.push({ code: "overreach.capability", call_id: id });
      compliance = "overreach";
    }
    if (ev["session_contract.network"] === true && contract.capabilities.network === "deny") {
      reasons.push({ code: "overreach.network", call_id: id });
      compliance = "overreach";
    }
    const wp = ev["session_contract.write_paths"];
    if (cap === "fs.write") {
      if (!Array.isArray(wp) || wp.length === 0) {
        reasons.push({ code: "warning.unattested_write", call_id: id });
      } else {
        for (const p of wp) {
          if (typeof p !== "string" || !pathUnderAnyRoot(p, contract.writable_roots)) {
            reasons.push({ code: "overreach.write_path", call_id: id });
            compliance = "overreach";
            break;
          }
        }
      }
    }
  }

  const stillOpen = new Set();
  for (const ev of events) {
    if (ev.kind === "tool_call") {
      stillOpen.add(/** @type {string} */ (ev["gen_ai.tool.call.id"]));
    } else if (ev.kind === "tool_result") {
      stillOpen.delete(/** @type {string} */ (ev["gen_ai.tool.call.id"]));
    }
  }
  const dangling = stillOpen;

  let lastPair = null;
  let streakLen = 0;
  let streakFirstId = null;
  let suspected_spin = false;

  const flushStreak = () => {
    if (streakLen >= contract.n && streakFirstId) {
      reasons.push({ code: "spin.redundant_streak", call_id: streakFirstId });
      suspected_spin = true;
    }
    streakLen = 0;
    streakFirstId = null;
    lastPair = null;
  };

  /** @type {Map<string, Record<string, unknown>>} */
  const pending = new Map();
  for (const ev of events) {
    if (ev.kind === "tool_call") {
      const id = /** @type {string} */ (ev["gen_ai.tool.call.id"]);
      pending.set(id, ev);
      if (dangling.has(id)) {
        flushStreak();
      }
      continue;
    }
    if (ev.kind !== "tool_result") continue;
    const id = /** @type {string} */ (ev["gen_ai.tool.call.id"]);
    const call = pending.get(id);
    if (!call || dangling.has(id)) continue;
    pending.delete(id);

    const cap = /** @type {string} */ (call["session_contract.capability"]);
    const args = /** @type {string} */ (call["session_contract.arguments_sha256"]);
    const res = /** @type {string} */ (ev["session_contract.result_sha256"]);
    const noProgress = ev["session_contract.progress"] !== true;
    const matches =
      lastPair !== null &&
      lastPair.cap === cap &&
      lastPair.args === args &&
      noProgress &&
      lastPair.res === res;

    if (matches) {
      streakLen += 1;
    } else {
      flushStreak();
      streakLen = 1;
      streakFirstId = id;
    }
    lastPair = { cap, args, res };
  }
  flushStreak();

  for (const id of openOrder) {
    if (dangling.has(id)) {
      reasons.push({ code: "warning.unmatched_tool_call", call_id: id });
    }
  }

  if (hasEnd) reasons.push({ code: "incomplete.goal" });
  else reasons.push({ code: "incomplete.truncated" });

  return {
    outcome: "incomplete",
    compliance,
    suspected_spin,
    reasons,
  };
}
