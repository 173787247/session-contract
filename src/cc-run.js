import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { CliError } from "./errors.js";

export function defaultPackDir(now = new Date(), rand = randomBytes(2).toString("hex")) {
  const utc = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return join(".session-contract", "packs", `${utc}-${rand}`);
}

/**
 * Windows `spawnSync("claude")` is ENOENT; the npm shim is `claude.cmd`.
 * Run it via `cmd.exe /d /s /c` so the batch's exit code and quoted argv survive.
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveClaudeBin(bin, env = process.env) {
  if (bin !== "claude" && existsSync(bin)) return bin;
  if (bin !== "claude") return bin;
  const pathEnv = env.PATH || env.Path || "";
  const names = process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return bin;
}

/**
 * cmd.exe quoting: double `%` (even inside quotes), then wrap and double `"`.
 * @param {string} s
 */
export function cmdQuote(s) {
  const t = String(s).replaceAll("%", "%%");
  if (t.length === 0) return '""';
  if (!/[\s"&<>|^()]/.test(t)) return t;
  return `"${t.replaceAll('"', '""')}"`;
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
export function claudeSpawnOpts(bin, args, env) {
  const winShim = process.platform === "win32" && !/\.exe$/i.test(bin);
  if (!winShim) return { bin, args, opts: { env, stdio: "inherit", shell: false } };
  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
  const cmdline = [cmdQuote(bin), ...args.map(cmdQuote)].join(" ");
  return {
    bin: comspec,
    args: ["/d", "/s", "/c", cmdline],
    opts: { env, stdio: "inherit", shell: false, windowsVerbatimArguments: true },
  };
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
  const bin = resolveClaudeBin(env.SESSION_CONTRACT_CLAUDE || "claude", env);
  const spawn = io.spawn ?? spawnSync;
  const launched = claudeSpawnOpts(bin, claudeArgs, env);
  const result = spawn(launched.bin, launched.args, launched.opts);
  if (result.error) throw new CliError(2, `cannot exec ${bin}: ${result.error.message}`);
  return typeof result.status === "number" ? result.status : 1;
}
