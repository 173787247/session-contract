import { createHash } from "node:crypto";
import { canonical } from "./canonical.js";
import { ZERO_PREV } from "./errors.js";

/** @param {Buffer | string} data */
export function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * @param {Record<string, unknown>} event without requiring hash/prev
 * @param {string} prev
 */
export function sealEvent(event, prev) {
  const payload = { ...event };
  delete payload.hash;
  delete payload.prev;
  const hash = sha256hex(`${prev}\n${canonical(payload)}`);
  return { ...payload, prev, hash };
}

/** @param {Record<string, unknown>[]} events */
export function sealChain(events) {
  const out = [];
  let prev = ZERO_PREV;
  for (const ev of events) {
    const sealed = sealEvent(ev, prev);
    out.push(sealed);
    prev = sealed.hash;
  }
  return out;
}

/** @param {Record<string, unknown>} event */
export function eventPayload(event) {
  const payload = { ...event };
  delete payload.hash;
  delete payload.prev;
  return payload;
}
