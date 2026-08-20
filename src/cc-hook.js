import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, releaseLock } from "./cc-lock.js";
import { CC_EVENTS } from "./cc-map.js";
import {
  argumentsShaFromInput,
  digestBody,
  isCcOmitted,
  mapCcTool,
  resultSha256,
  writePathsFromCcInput,
} from "./cc-map.js";
import { commitEvents, loadHealedEvents, pushSealed } from "./cc-writer.js";
import { CliError } from "./errors.js";
import { sha256hex } from "./hash.js";

/**
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {string} pack
 * @param {string} ts
 */
export function applyHook(eventName, payload, pack, ts) {
  if (!existsSync(join(pack, "contract.md"))) {
    throw new CliError(1, "missing contract.md");
  }
  const events = loadHealedEvents(pack);
  const last = events[events.length - 1];
  if (last?.kind === "end") {
    commitEvents(pack, events);
    return { status: "ended" };
  }
  const hasStart = events.some((e) => e.kind === "start");
  if (eventName === "SessionStart" && hasStart) {
    commitEvents(pack, events);
    return { status: "noop" };
  }
  const next = [...events];
  if (!hasStart) {
    ensureStart(next, pack, payload, ts);
  }
  if (eventName === "SessionStart") {
    commitEvents(pack, next);
    return { status: "ok" };
  }
  if (eventName === "SessionEnd") {
    pushSealed(next, { kind: "end", ts, stop_reason: "user" });
    commitEvents(pack, next);
    return { status: "ok" };
  }
  if (eventName === "StopFailure") {
    pushSealed(next, { kind: "end", ts, stop_reason: "error" });
    commitEvents(pack, next);
    return { status: "ok" };
  }
  emitTool(next, eventName, payload, ts);
  commitEvents(pack, next);
  return { status: "ok" };
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {string} pack
 * @param {Record<string, unknown>} payload
 * @param {string} ts
 */
function ensureStart(events, pack, payload, ts) {
  const contractSha256 = sha256hex(readFileSync(join(pack, "contract.md")));
  /** @type {Record<string, unknown>} */
  const start = {
    kind: "start",
    ts,
    contract_sha256: contractSha256,
    harness: "claude-code",
  };
  if (typeof payload.session_id === "string") start.session_id = payload.session_id;
  if (typeof payload.source === "string") start.source = payload.source;
  if (typeof payload.session_title === "string") start.session_title = payload.session_title;
  pushSealed(events, start);
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {string} ts
 */
function emitTool(events, eventName, payload, ts) {
  const name = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
  const id = typeof payload.tool_use_id === "string" ? payload.tool_use_id : "";
  if (!id) throw new CliError(1, "missing tool_use_id");
  const mapped = mapCcTool(name);
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;

  if (eventName === "PreToolUse") {
    pushSealed(events, toolCallPayload(name, id, payload.tool_input, mapped, ts, cwd));
    return;
  }

  const hasCall = events.some((e) => e.kind === "tool_call" && e["gen_ai.tool.call.id"] === id);
  if (!hasCall) {
    pushSealed(events, toolCallPayload(name, id, payload.tool_input, mapped, ts, cwd));
  }

  let isError = false;
  let digest;
  if (eventName === "PostToolUse") {
    isError = false;
    digest = digestBody(payload.tool_response);
  } else if (eventName === "PostToolUseFailure") {
    isError = true;
    digest = digestBody(typeof payload.error === "string" ? payload.error : "");
  } else if (eventName === "PermissionDenied") {
    isError = true;
    digest = digestBody(typeof payload.reason === "string" ? payload.reason : "");
  } else {
    throw new CliError(1, `unhandled event ${eventName}`);
  }
  pushSealed(events, {
    kind: "tool_result",
    ts,
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": name,
    "gen_ai.tool.call.id": id,
    "session_contract.result_sha256": resultSha256(isError, digest),
  });
}

/**
 * @param {string} name
 * @param {string} id
 * @param {unknown} toolInput
 * @param {{ capability: string, write: boolean, network: boolean }} mapped
 * @param {string} ts
 * @param {string | undefined} cwd
 */
function toolCallPayload(name, id, toolInput, mapped, ts, cwd) {
  const write_paths = mapped.write ? writePathsFromCcInput(toolInput, cwd) : [];
  /** @type {Record<string, unknown>} */
  const ev = {
    kind: "tool_call",
    ts,
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": name,
    "gen_ai.tool.call.id": id,
    "session_contract.capability": mapped.capability,
    "session_contract.arguments_sha256": argumentsShaFromInput(toolInput ?? {}),
    "session_contract.write_paths": write_paths,
  };
  if (mapped.network) ev["session_contract.network"] = true;
  return ev;
}

function agentIdSet(payload) {
  return Object.hasOwn(payload, "agent_id") && payload.agent_id != null && payload.agent_id !== "";
}

/**
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {{ pack?: string, ts?: string }} [opts]
 */
export function runCcHook(eventName, payload, opts = {}) {
  const pack = opts.pack ?? process.env.SESSION_CONTRACT_PACK;
  if (!pack) throw new CliError(1, "SESSION_CONTRACT_PACK unset");
  try {
    if (!statSync(pack).isDirectory()) throw new CliError(1, "SESSION_CONTRACT_PACK is not a directory");
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(1, "SESSION_CONTRACT_PACK is not a directory");
  }
  if (payload.hook_event_name !== eventName) {
    throw new CliError(1, "hook_event_name does not match argv");
  }
  if (!CC_EVENTS.includes(eventName)) return { status: "skip" };
  if (agentIdSet(payload)) return { status: "skip" };
  if (typeof payload.tool_name === "string" && isCcOmitted(payload.tool_name)) {
    return { status: "skip" };
  }
  const ts = opts.ts ?? new Date().toISOString();
  if (!acquireLock(pack, eventName)) {
    throw new CliError(1, "lock not acquired");
  }
  try {
    return applyHook(eventName, payload, pack, ts);
  } finally {
    releaseLock(pack);
  }
}

/**
 * @param {string} raw
 */
export function parseHookStdin(raw) {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return /** @type {Record<string, unknown>} */ (v);
  } catch {
    throw new CliError(1, "stdin is not a JSON object");
  }
}
