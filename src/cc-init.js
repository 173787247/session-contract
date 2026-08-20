import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CC_EVENTS, CORE_EVENTS, OPTIONAL_EVENTS } from "./cc-map.js";
import { CliError } from "./errors.js";

export function sessionContractBin() {
  return fileURLToPath(new URL("../bin/session-contract.js", import.meta.url));
}

/**
 * D1 shell form. Native path, double-quoted. No $VAR, &&, or pipes.
 * @param {string} bin
 * @param {string} eventName
 */
export function hookCommand(bin, eventName) {
  return `node "${bin}" cc-hook ${eventName}`;
}

/**
 * @param {boolean} [full]
 */
export function emitEvents(full = false) {
  return full ? CC_EVENTS : CORE_EVENTS;
}

/**
 * @param {boolean} [full]
 */
export function hooksFragment(full = false) {
  const bin = sessionContractBin();
  /** @type {Record<string, unknown>} */
  const hooks = {};
  for (const ev of emitEvents(full)) {
    hooks[ev] = [
      {
        matcher: "",
        hooks: [{ type: "command", command: hookCommand(bin, ev) }],
      },
    ];
  }
  return { hooks };
}

function hookList(entry) {
  const hooks = entry && typeof entry === "object" ? /** @type {Record<string, unknown>} */ (entry).hooks : null;
  return Array.isArray(hooks) ? hooks : [];
}

function isShellOurs(entry, eventName) {
  const needle = `cc-hook ${eventName}`;
  return hookList(entry).some((h) => {
    if (!h || typeof h !== "object") return false;
    const cmd = /** @type {Record<string, unknown>} */ (h).command;
    return typeof cmd === "string" && cmd.includes(needle);
  });
}

function isLegacyArgsOurs(entry, eventName) {
  if (isShellOurs(entry, eventName)) return false;
  return hookList(entry).some((h) => {
    if (!h || typeof h !== "object") return false;
    const args = /** @type {Record<string, unknown>} */ (h).args;
    return Array.isArray(args) && args.includes("cc-hook") && args.includes(eventName);
  });
}

function isOurs(entry, eventName) {
  return isShellOurs(entry, eventName) || isLegacyArgsOurs(entry, eventName);
}

/**
 * @param {Record<string, unknown>} existing
 * @param {ReturnType<typeof hooksFragment>} fragment
 * @param {boolean} [full]
 */
export function mergeSettings(existing, fragment, full = false) {
  const out = { ...existing };
  const prevHooks = existing.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
    ? /** @type {Record<string, unknown>} */ (existing.hooks)
    : {};
  /** @type {Record<string, unknown>} */
  const hooks = { ...prevHooks };
  const emit = new Set(emitEvents(full));
  for (const ev of CC_EVENTS) {
    const list = Array.isArray(hooks[ev]) ? [.../** @type {unknown[]} */ (hooks[ev])] : [];
    if (!full && OPTIONAL_EVENTS.includes(ev)) {
      const kept = list.filter((entry) => !isOurs(entry, ev));
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
      continue;
    }
    if (!emit.has(ev)) continue;
    const upgraded = list.filter((entry) => !isLegacyArgsOurs(entry, ev));
    if (!upgraded.some((entry) => isShellOurs(entry, ev))) {
      upgraded.push(fragment.hooks[ev][0]);
    }
    hooks[ev] = upgraded;
  }
  out.hooks = hooks;
  return out;
}

export function userSettingsPath() {
  return join(homedir(), ".claude", "settings.json");
}

export function projectSettingsPath(cwd = process.cwd()) {
  return join(cwd, ".claude", "settings.json");
}

/**
 * @param {"print" | "user" | "project"} mode
 * @param {string} [cwd]
 * @param {boolean} [full]
 */
export function runCcInit(mode, cwd = process.cwd(), full = false) {
  const fragment = hooksFragment(full);
  if (mode === "print") {
    return { json: fragment, path: null };
  }
  const path = mode === "user" ? userSettingsPath() : projectSettingsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  /** @type {Record<string, unknown>} */
  let existing = {};
  if (existsSync(path)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new CliError(1, `settings JSON does not parse: ${path}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError(1, `settings JSON is not an object: ${path}`);
    }
    existing = parsed;
  }
  const merged = mergeSettings(existing, fragment, full);
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { json: merged, path };
}
