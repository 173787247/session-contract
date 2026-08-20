import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { adaptDsh } from "./adapt-dsh.js";
import { parseHookStdin, runCcHook } from "./cc-hook.js";
import { runCcInit } from "./cc-init.js";
import { runCcRun } from "./cc-run.js";
import { checkPack } from "./check.js";
import { CliError } from "./errors.js";

function usage() {
  return [
    "usage:",
    "  session-contract check <pack>",
    "  session-contract adapt dsh <zip-or-jsonl> --out <pack> [--contract <file>]",
    "  session-contract cc-hook <Event>",
    "  session-contract cc-run --contract <file> [--pack <dir>] [--] <claude args…>",
    "  session-contract cc-init [--print] [--write user|project]",
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: { write: (s: string) => void }, stderr?: { write: (s: string) => void }, stdin?: string, env?: NodeJS.ProcessEnv, spawn?: typeof import("node:child_process").spawnSync }} [io]
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const hook = argv[0] === "cc-hook";
  try {
    return run(argv, stdout, stderr, io);
  } catch (e) {
    if (e instanceof CliError) {
      stderr.write(`${e.message}\n`);
      return hook ? (e.exitCode === 2 ? 1 : e.exitCode) : e.exitCode;
    }
    stderr.write(`${e && e.message ? e.message : e}\n`);
    return hook ? 1 : 2;
  }
}

/**
 * @param {string[]} argv
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {{ stdin?: string, env?: NodeJS.ProcessEnv, spawn?: typeof import("node:child_process").spawnSync }} io
 */
function run(argv, stdout, stderr, io) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    throw new CliError(2, usage());
  }
  const cmd = argv[0];
  if (cmd === "check") {
    if (argv.length !== 2 || argv[1].startsWith("-")) throw new CliError(2, usage());
    const result = checkPack(argv[1]);
    stdout.write(
      `outcome=${result.outcome} compliance=${result.compliance} suspected_spin=${result.suspected_spin} verdict=${result.verdict}\n`,
    );
    return 0;
  }
  if (cmd === "adapt") {
    return runAdapt(argv.slice(1), stdout);
  }
  if (cmd === "cc-hook") {
    return runCcHookCli(argv.slice(1), stderr, io);
  }
  if (cmd === "cc-run") {
    return runCcRun(argv.slice(1), { stderr, env: io.env ?? process.env, spawn: io.spawn });
  }
  if (cmd === "cc-init") {
    return runCcInitCli(argv.slice(1), stdout);
  }
  throw new CliError(2, usage());
}

/**
 * @param {string[]} argv
 * @param {{ write: (s: string) => void }} stderr
 * @param {{ stdin?: string, env?: NodeJS.ProcessEnv }} io
 */
function runCcHookCli(argv, stderr, io) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    throw new CliError(1, "usage: session-contract cc-hook <Event>");
  }
  const raw = typeof io.stdin === "string" ? io.stdin : readFileSync(0, "utf8");
  const payload = parseHookStdin(raw);
  const result = runCcHook(argv[0], payload, { pack: io.env?.SESSION_CONTRACT_PACK ?? process.env.SESSION_CONTRACT_PACK });
  if (result.status === "ended") {
    stderr.write("refused: log already ended\n");
  }
  return 0;
}

/**
 * @param {string[]} argv
 * @param {{ write: (s: string) => void }} stdout
 */
function runCcInitCli(argv, stdout) {
  /** @type {"print" | "user" | "project"} */
  let mode = "print";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print") {
      mode = "print";
      continue;
    }
    if (a === "--write") {
      const dest = argv[++i];
      if (dest !== "user" && dest !== "project") throw new CliError(2, usage());
      mode = dest;
      continue;
    }
    throw new CliError(2, usage());
  }
  const result = runCcInit(mode);
  if (mode === "print") {
    stdout.write(`${JSON.stringify(result.json, null, 2)}\n`);
  }
  return 0;
}

/**
 * @param {string[]} argv
 * @param {{ write: (s: string) => void }} stdout
 */
function runAdapt(argv, stdout) {
  if (argv[0] !== "dsh") throw new CliError(2, usage());
  const rest = argv.slice(1);
  /** @type {string | undefined} */
  let input;
  /** @type {string | undefined} */
  let out;
  /** @type {string | undefined} */
  let contract;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") {
      out = rest[++i];
      continue;
    }
    if (a === "--contract") {
      contract = rest[++i];
      continue;
    }
    if (a.startsWith("-")) throw new CliError(2, usage());
    if (input) throw new CliError(2, usage());
    input = a;
  }
  if (!input || !out) throw new CliError(2, usage());
  const result = adaptDsh(input, out, contract);
  stdout.write(`out=${resolve(result.out)}\n`);
  return 0;
}
