import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";

const STEAL_MS = 60_000;
const DELAY_MS = 25;

export function lockPath(pack) {
  return join(pack, "evidence.ndjson.lock");
}

function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * @param {string} eventName
 */
export function lockAttempts(eventName) {
  return eventName === "SessionEnd" || eventName === "StopFailure" ? 40 : 200;
}

/**
 * @param {string} pack
 * @param {string} eventName
 * @returns {boolean}
 */
export function acquireLock(pack, eventName) {
  const file = lockPath(pack);
  const attempts = lockAttempts(eventName);
  for (let i = 0; i < attempts; i++) {
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, Buffer.from(`${process.pid}\n`));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      try {
        const st = statSync(file);
        if (Date.now() - st.mtimeMs > STEAL_MS) {
          try {
            unlinkSync(file);
          } catch {
            /* raced */
          }
          continue;
        }
      } catch {
        /* gone */
      }
      sleep(DELAY_MS);
    }
  }
  return false;
}

/**
 * @param {string} pack
 */
export function releaseLock(pack) {
  try {
    unlinkSync(lockPath(pack));
  } catch {
    /* already gone */
  }
}

/**
 * Test helper: plant a stealable lock.
 * @param {string} pack
 * @param {number} ageMs
 */
export function plantStaleLock(pack, ageMs = STEAL_MS + 1000) {
  const file = lockPath(pack);
  const fd = openSync(file, "w");
  writeSync(fd, Buffer.from("1\n"));
  closeSync(fd);
  const past = new Date(Date.now() - ageMs);
  utimesSync(file, past, past);
}
