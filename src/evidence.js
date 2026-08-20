import { assertJsonValue } from "./canonical.js";
import { CAPABILITIES, CliError, KINDS, STOP_REASONS, ZERO_PREV } from "./errors.js";
import { eventPayload, sha256hex } from "./hash.js";
import { canonical } from "./canonical.js";

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
export function parseEvidenceNdjson(text) {
  const lines = text.split(/\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw new CliError(1, "evidence.ndjson is empty");
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") throw new CliError(1, `evidence.ndjson: empty line ${i + 1}`);
    if (line.includes("\r")) throw new CliError(1, `evidence.ndjson: CR on line ${i + 1}`);
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new CliError(1, `evidence.ndjson: invalid JSON on line ${i + 1}`);
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new CliError(1, `evidence.ndjson: line ${i + 1} is not an object`);
    }
    try {
      assertJsonValue(obj, `line ${i + 1}`);
    } catch (e) {
      throw new CliError(1, `evidence.ndjson: ${e.message}`);
    }
    events.push(obj);
  }
  return events;
}

/**
 * @param {Record<string, unknown>[]} events
 */
export function validateChain(events) {
  let seenEnd = false;
  let prev = ZERO_PREV;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const kind = ev.kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      throw new CliError(1, `invalid kind on event ${i}`);
    }
    if (i === 0 && kind !== "start") {
      throw new CliError(1, "first event must be start");
    }
    if (i > 0 && kind === "start") {
      throw new CliError(1, "start must be exactly one, first line");
    }
    if (seenEnd) {
      throw new CliError(1, "event after end");
    }
    if (kind === "end") {
      if (events.slice(0, i).some((e) => e.kind === "end")) {
        throw new CliError(1, "multiple end events");
      }
      seenEnd = true;
    }
    if (typeof ev.ts !== "string" || !TS.test(ev.ts)) {
      throw new CliError(1, `event ${i}: ts must be RFC 3339 UTC with Z`);
    }
    if (typeof ev.prev !== "string" || !/^[0-9a-f]{64}$/.test(ev.prev)) {
      throw new CliError(1, `event ${i}: prev missing`);
    }
    if (typeof ev.hash !== "string" || !/^[0-9a-f]{64}$/.test(ev.hash)) {
      throw new CliError(1, `event ${i}: hash missing`);
    }
    if (ev.prev !== prev) {
      throw new CliError(1, `event ${i}: prev mismatch`);
    }
    const expected = sha256hex(`${prev}\n${canonical(eventPayload(ev))}`);
    if (ev.hash !== expected) {
      throw new CliError(1, `event ${i}: hash mismatch`);
    }
    validateKindShape(ev, i);
    prev = ev.hash;
  }
  return { chainTip: events[events.length - 1].hash, hasEnd: seenEnd };
}

/**
 * @param {Record<string, unknown>} ev
 * @param {number} i
 */
function validateKindShape(ev, i) {
  const kind = ev.kind;
  if (kind === "start") {
    if (typeof ev.contract_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ev.contract_sha256)) {
      throw new CliError(1, `event ${i}: start.contract_sha256`);
    }
    if (typeof ev.harness !== "string" || ev.harness.length === 0) {
      throw new CliError(1, `event ${i}: start.harness`);
    }
    return;
  }
  if (kind === "end") {
    if (typeof ev.stop_reason !== "string" || !STOP_REASONS.has(ev.stop_reason)) {
      throw new CliError(1, `event ${i}: end.stop_reason`);
    }
    return;
  }
  if (ev["gen_ai.operation.name"] !== "execute_tool") {
    throw new CliError(1, `event ${i}: gen_ai.operation.name`);
  }
  if (typeof ev["gen_ai.tool.name"] !== "string" || ev["gen_ai.tool.name"].length === 0) {
    throw new CliError(1, `event ${i}: gen_ai.tool.name`);
  }
  if (typeof ev["gen_ai.tool.call.id"] !== "string" || ev["gen_ai.tool.call.id"].length === 0) {
    throw new CliError(1, `event ${i}: gen_ai.tool.call.id`);
  }
  if (kind === "tool_call") {
    if (typeof ev["session_contract.capability"] !== "string" || !CAPABILITIES.has(ev["session_contract.capability"])) {
      throw new CliError(1, `event ${i}: session_contract.capability`);
    }
    if (typeof ev["session_contract.arguments_sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(ev["session_contract.arguments_sha256"])) {
      throw new CliError(1, `event ${i}: session_contract.arguments_sha256`);
    }
    const wp = ev["session_contract.write_paths"];
    if (wp !== undefined && !Array.isArray(wp)) {
      throw new CliError(1, `event ${i}: write_paths must be an array`);
    }
    if (Array.isArray(wp)) {
      for (const p of wp) {
        if (typeof p !== "string") throw new CliError(1, `event ${i}: write_paths entries must be strings`);
      }
    }
    const net = ev["session_contract.network"];
    if (net !== undefined && typeof net !== "boolean") {
      throw new CliError(1, `event ${i}: session_contract.network`);
    }
  }
  if (kind === "tool_result") {
    if (typeof ev["session_contract.result_sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(ev["session_contract.result_sha256"])) {
      throw new CliError(1, `event ${i}: session_contract.result_sha256`);
    }
    const prog = ev["session_contract.progress"];
    if (prog !== undefined && typeof prog !== "boolean") {
      throw new CliError(1, `event ${i}: session_contract.progress`);
    }
  }
}

/**
 * @param {Record<string, unknown>[]} events
 */
export function formatNdjson(events) {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
