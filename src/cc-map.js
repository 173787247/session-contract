import { canonical } from "./canonical.js";
import { sha256hex } from "./hash.js";
import { resolveAgainstCwd } from "./paths.js";

export const CC_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "SessionEnd",
  "StopFailure",
];

/** 2.1.87 intersection: registering these does not zero all matchers. */
export const CORE_EVENTS = CC_EVENTS.filter((e) => e !== "PermissionDenied");

/** Type-0 poison on 2.1.87: unknown key → every matcher becomes 0. Opt-in via `--full`. */
export const OPTIONAL_EVENTS = ["PermissionDenied"];

const OMIT = new Set([
  "Task",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskOutput",
  "KillShell",
  "BashOutput",
]);

const EMIT = {
  Read: { capability: "fs.read", write: false, network: false },
  Glob: { capability: "fs.read", write: false, network: false },
  Grep: { capability: "fs.read", write: false, network: false },
  Skill: { capability: "fs.read", write: false, network: false },
  Write: { capability: "fs.write", write: true, network: false },
  Edit: { capability: "fs.write", write: true, network: false },
  NotebookEdit: { capability: "fs.write", write: true, network: false },
  Bash: { capability: "exec", write: false, network: false },
  PowerShell: { capability: "exec", write: false, network: false },
  WebFetch: { capability: "network", write: false, network: true },
  WebSearch: { capability: "network", write: false, network: true },
};

export function isCcOmitted(name) {
  return typeof name === "string" && OMIT.has(name);
}

/**
 * @param {string} name
 */
export function mapCcTool(name) {
  if (isCcOmitted(name)) return null;
  if (typeof name === "string" && name.startsWith("mcp__")) {
    return { capability: "network", write: false, network: true };
  }
  return EMIT[name] ?? { capability: "exec", write: false, network: false };
}

/**
 * @param {unknown} value
 */
export function argumentsShaFromInput(value) {
  try {
    return sha256hex(canonical(value ?? ""));
  } catch {
    return sha256hex(canonical(JSON.stringify(value ?? "")));
  }
}

/**
 * Adapter §3.4: object → UTF-8 of canonical(); else UTF-8 of String().
 * @param {unknown} value
 */
export function digestBody(value) {
  if (value === undefined || value === null) return sha256hex(Buffer.alloc(0));
  if (value !== null && typeof value === "object") {
    try {
      return sha256hex(Buffer.from(canonical(value), "utf8"));
    } catch {
      return sha256hex(Buffer.from(JSON.stringify(value) ?? "", "utf8"));
    }
  }
  return sha256hex(Buffer.from(String(value), "utf8"));
}

/**
 * @param {boolean} isError
 * @param {string} digest
 */
export function resultSha256(isError, digest) {
  return sha256hex(canonical({ isError, digest }));
}

/**
 * @param {unknown} toolInput
 * @param {string | undefined} cwd
 */
export function writePathsFromCcInput(toolInput, cwd) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const rec = /** @type {Record<string, unknown>} */ (toolInput);
  const raw = typeof rec.file_path === "string" ? rec.file_path : typeof rec.notebook_path === "string" ? rec.notebook_path : null;
  if (!raw) return [];
  const abs = resolveAgainstCwd(raw, cwd);
  return abs ? [abs] : [];
}
