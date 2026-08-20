import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ZERO_PREV } from "./errors.js";
import { formatNdjson } from "./evidence.js";
import { sealEvent, sha256hex } from "./hash.js";
import { formatSidecar } from "./sidecar.js";

export function evidencePath(pack) {
  return join(pack, "evidence.ndjson");
}

export function sidecarPath(pack) {
  return join(pack, "evidence.ndjson.sha256");
}

/**
 * @param {string} dest
 * @param {Buffer | string} contents
 */
export function atomicWrite(dest, contents) {
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const tmp = `${dest}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, dest);
  } catch {
    try {
      unlinkSync(dest);
    } catch {
      /* missing */
    }
    renameSync(tmp, dest);
  }
}

/**
 * Truncate a torn last line. Returns UTF-8 text ending in LF, or "".
 * @param {Buffer} buf
 */
export function healTornNdjson(buf) {
  if (!buf.length) return "";
  let text = buf.toString("utf8");
  if (!text.endsWith("\n")) {
    const lastLf = text.lastIndexOf("\n");
    text = lastLf === -1 ? "" : text.slice(0, lastLf + 1);
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  while (lines.length) {
    try {
      JSON.parse(lines[lines.length - 1]);
      break;
    } catch {
      lines.pop();
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * @param {string} pack
 * @returns {Record<string, unknown>[]}
 */
export function loadHealedEvents(pack) {
  const p = evidencePath(pack);
  if (!existsSync(p)) return [];
  const healed = healTornNdjson(readFileSync(p));
  if (!healed) return [];
  const lines = healed.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => JSON.parse(line));
}

/**
 * @param {string} pack
 * @param {Record<string, unknown>[]} events
 */
export function commitEvents(pack, events) {
  const ndjson = events.length ? formatNdjson(events) : "";
  const buf = Buffer.from(ndjson, "utf8");
  atomicWrite(evidencePath(pack), buf);
  if (events.length) {
    const tip = /** @type {string} */ (events[events.length - 1].hash);
    atomicWrite(sidecarPath(pack), formatSidecar(sha256hex(buf), tip));
  } else if (existsSync(sidecarPath(pack))) {
    unlinkSync(sidecarPath(pack));
  }
}

/**
 * @param {Record<string, unknown>[]} events
 */
export function chainTip(events) {
  if (!events.length) return ZERO_PREV;
  return /** @type {string} */ (events[events.length - 1].hash);
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {Record<string, unknown>} payload
 */
export function pushSealed(events, payload) {
  events.push(sealEvent(payload, chainTip(events)));
}

export { ZERO_PREV };
