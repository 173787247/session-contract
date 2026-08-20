import { decompressDshZstd } from "./zstd-frames.js";
import { canonical } from "./canonical.js";
import { CliError } from "./errors.js";
import { sha256hex } from "./hash.js";
import { resolveAgainstCwd } from "./paths.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const OMIT_EXACT = new Set([
  "todo_write",
  "create_goal",
  "get_goal",
  "update_goal",
  "ask_user_question",
  "send_message",
  "interrupt_agent",
  "list_agents",
  "exit_plan_mode",
  "job_output",
  "job_list",
  "job_kill",
  "ralph",
]);

const CHUNK_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);

const EMIT = {
  read: { capability: "fs.read", write: false, network: false },
  read_image: { capability: "fs.read", write: false, network: false },
  write: { capability: "fs.write", write: true, network: false },
  edit: { capability: "fs.write", write: true, network: false },
  bash: { capability: "exec", write: false, network: false },
  grep: { capability: "fs.read", write: false, network: false },
  glob: { capability: "fs.read", write: false, network: false },
  skill: { capability: "fs.read", write: false, network: false },
  web_search: { capability: "network", write: false, network: true },
  web_fetch: { capability: "network", write: false, network: true },
  net_doctor: { capability: "network", write: false, network: true },
};

export function isOmittedName(name) {
  if (OMIT_EXACT.has(name)) return true;
  if (name.startsWith("subagent")) return true;
  if (name.startsWith("workflow")) return true;
  return false;
}

/**
 * @param {string} name
 */
export function mapDshTool(name) {
  if (isOmittedName(name)) return null;
  return EMIT[name] ?? { capability: "exec", write: false, network: false };
}

/**
 * @param {Buffer} buf
 */
export function decodeSessionBytes(buf) {
  try {
    if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
      return decompressDshZstd(buf).toString("utf8");
    }
    return buf.toString("utf8");
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(1, `invalid session artifact: ${e.message}`);
  }
}

/**
 * @param {unknown} ms
 */
export function isoFromEpochMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new CliError(1, "invalid epoch milliseconds in session log");
  }
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} argumentsText
 */
export function argumentsSha256(argumentsText) {
  if (typeof argumentsText !== "string") {
    return sha256hex(canonical(""));
  }
  try {
    const parsed = JSON.parse(argumentsText);
    return sha256hex(canonical(parsed));
  } catch {
    return sha256hex(canonical(argumentsText));
  }
}

/**
 * @param {unknown} data
 */
export function resultDigestFromToolResult(data) {
  const content = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data).message : undefined;
  const msg = content && typeof content === "object" ? /** @type {Record<string, unknown>} */ (content) : null;
  const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
  return sha256hex(canonical(blocks));
}

/**
 * @param {unknown} data
 */
export function toolResultIsError(data) {
  const rec = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  if (rec.error) return true;
  const msg = rec.message && typeof rec.message === "object" ? /** @type {Record<string, unknown>} */ (rec.message) : null;
  const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
  const first = blocks[0];
  if (first && typeof first === "object" && /** @type {Record<string, unknown>} */ (first).isError === true) return true;
  return false;
}

/**
 * @param {unknown} data
 * @returns {string | null}
 */
export function toolResultCallId(data) {
  const rec = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  const msg = rec.message && typeof rec.message === "object" ? /** @type {Record<string, unknown>} */ (rec.message) : null;
  const source = msg && msg.source && typeof msg.source === "object" ? /** @type {Record<string, unknown>} */ (msg.source) : null;
  if (source && typeof source.callId === "string") return source.callId;
  const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
  const first = blocks[0] && typeof blocks[0] === "object" ? /** @type {Record<string, unknown>} */ (blocks[0]) : null;
  if (first && typeof first.toolCallId === "string") return first.toolCallId;
  return null;
}

/**
 * @param {unknown} argumentsText
 * @param {string | undefined} cwd
 */
export function writePathsFromArgs(argumentsText, cwd) {
  if (typeof argumentsText !== "string") return [];
  try {
    const parsed = JSON.parse(argumentsText);
    if (!parsed || typeof parsed !== "object") return [];
    const fp = parsed.file_path;
    if (typeof fp !== "string" || fp.length === 0) return [];
    const abs = resolveAgainstCwd(fp, cwd);
    return abs ? [abs] : [];
  } catch {
    return [];
  }
}

/**
 * @param {unknown} reason
 * @returns {"user" | "model" | "error" | "abort" | null}
 */
export function mapTurnEndReason(reason) {
  if (!reason || typeof reason !== "object") return null;
  const kind = /** @type {Record<string, unknown>} */ (reason).kind;
  if (kind === "completed" || kind === "max-tokens") return "model";
  if (kind === "error") return "error";
  if (kind === "interrupted") return "abort";
  if (kind === "blocked") return null;
  if (kind === "aborted") {
    const cause = /** @type {Record<string, unknown>} */ (reason).reason;
    const ck = cause && typeof cause === "object" ? /** @type {Record<string, unknown>} */ (cause).kind : undefined;
    if (ck === "user") return "user";
    if (ck === "parent" || ck === "hook" || ck === "disposed" || ck === "legacy") return "abort";
    return null;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} rec
 */
export function isSkippedSourceLine(rec) {
  if (rec.ignorable === true) return true;
  if (typeof rec.type === "string" && CHUNK_TYPES.has(rec.type)) return true;
  if (rec.type === "tool/call") {
    const data = rec.data && typeof rec.data === "object" ? /** @type {Record<string, unknown>} */ (rec.data) : {};
    if (typeof data.name === "string" && isOmittedName(data.name)) return true;
  }
  if (rec.type === "tool/result") return false;
  return false;
}
