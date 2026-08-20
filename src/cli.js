import { resolve } from "node:path";
import { adaptDsh } from "./adapt-dsh.js";
import { checkPack } from "./check.js";
import { CliError } from "./errors.js";

function usage() {
  return [
    "usage:",
    "  session-contract check <pack>",
    "  session-contract adapt dsh <zip-or-jsonl> --out <pack> [--contract <file>]",
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: { write: (s: string) => void }, stderr?: { write: (s: string) => void } }} [io]
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const code = run(argv, stdout);
    return code;
  } catch (e) {
    if (e instanceof CliError) {
      stderr.write(`${e.message}\n`);
      return e.exitCode;
    }
    stderr.write(`${e && e.message ? e.message : e}\n`);
    return 2;
  }
}

/**
 * @param {string[]} argv
 * @param {{ write: (s: string) => void }} stdout
 */
function run(argv, stdout) {
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
  throw new CliError(2, usage());
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
