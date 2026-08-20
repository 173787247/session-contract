import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { CliError } from "./errors.js";

export function defaultPackDir(now = new Date(), rand = randomBytes(2).toString("hex")) {
  const utc = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return join(".session-contract", "packs", `${utc}-${rand}`);
}

/**
 * @param {{ contract: string, pack?: string, claudeArgs: string[], env?: NodeJS.ProcessEnv }} opts
 */
export function prepareCcRun(opts) {
  const contract = resolve(opts.contract);
  if (!existsSync(contract) || !statSync(contract).isFile()) {
    throw new CliError(2, `contract not found: ${contract}`);
  }
  const pack = resolve(opts.pack ?? defaultPackDir());
  mkdirSync(pack, { recursive: true });
  const dest = join(pack, "contract.md");
  if (!existsSync(dest)) {
    copyFileSync(contract, dest);
  }
  if (!existsSync(dest)) throw new CliError(1, "failed to place contract.md in pack");
  return { pack, dest };
}

/**
 * @param {string[]} argv
 * @param {{ stderr: { write: (s: string) => void }, env?: NodeJS.ProcessEnv, spawn?: typeof spawnSync }} io
 */
export function runCcRun(argv, io) {
  /** @type {string | undefined} */
  let contract;
  /** @type {string | undefined} */
  let pack;
  const claudeArgs = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (passthrough) {
      claudeArgs.push(a);
      continue;
    }
    if (a === "--") {
      passthrough = true;
      continue;
    }
    if (a === "--contract") {
      contract = argv[++i];
      continue;
    }
    if (a === "--pack") {
      pack = argv[++i];
      continue;
    }
    if (a.startsWith("-")) throw new CliError(2, "usage: session-contract cc-run --contract <file> [--pack <dir>] [--] <claude args…>");
    claudeArgs.push(a);
  }
  if (!contract) throw new CliError(2, "usage: session-contract cc-run --contract <file> [--pack <dir>] [--] <claude args…>");
  const prepared = prepareCcRun({ contract, pack, claudeArgs });
  io.stderr.write(`pack=${prepared.pack}\n`);
  const env = { ...(io.env ?? process.env), SESSION_CONTRACT_PACK: prepared.pack };
  const bin = env.SESSION_CONTRACT_CLAUDE || "claude";
  const spawn = io.spawn ?? spawnSync;
  const result = spawn(bin, claudeArgs, { env, stdio: "inherit", shell: false });
  if (result.error) throw new CliError(2, `cannot exec ${bin}: ${result.error.message}`);
  return typeof result.status === "number" ? result.status : 1;
}
