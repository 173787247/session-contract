import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CC_EVENTS } from "./cc-map.js";
import { CliError } from "./errors.js";

export function sessionContractBin() {
  return fileURLToPath(new URL("../bin/session-contract.js", import.meta.url));
}

export function hooksFragment() {
  const bin = sessionContractBin();
  /** @type {Record<string, unknown>} */
  const hooks = {};
  for (const ev of CC_EVENTS) {
    hooks[ev] = [
      {
        matcher: "",
        hooks: [{ type: "command", command: "node", args: [bin, "cc-hook", ev] }],
      },
    ];
  }
  return { hooks };
}

function isOurs(entry, eventName) {
  const hooks = entry && typeof entry === "object" ? /** @type {Record<string, unknown>} */ (entry).hooks : null;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    if (!h || typeof h !== "object") return false;
    const args = /** @type {Record<string, unknown>} */ (h).args;
    return Array.isArray(args) && args.includes("cc-hook") && args.includes(eventName);
  });
}

/**
 * @param {Record<string, unknown>} existing
 * @param {ReturnType<typeof hooksFragment>} fragment
 */
export function mergeSettings(existing, fragment) {
  const out = { ...existing };
  const prevHooks = existing.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
    ? /** @type {Record<string, unknown>} */ (existing.hooks)
    : {};
  /** @type {Record<string, unknown>} */
  const hooks = { ...prevHooks };
  for (const ev of CC_EVENTS) {
    const list = Array.isArray(hooks[ev]) ? [.../** @type {unknown[]} */ (hooks[ev])] : [];
    if (!list.some((entry) => isOurs(entry, ev))) {
      list.push(fragment.hooks[ev][0]);
    }
    hooks[ev] = list;
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
 */
export function runCcInit(mode, cwd = process.cwd()) {
  const fragment = hooksFragment();
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
  const merged = mergeSettings(existing, fragment);
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { json: merged, path };
}
