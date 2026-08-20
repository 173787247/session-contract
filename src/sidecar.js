import { CliError } from "./errors.js";

const FILE_LINE = /^([0-9a-f]{64})[ \t]+evidence\.ndjson$/i;
const TIP_LINE = /^chain_tip[ \t]+([0-9a-f]{64})$/i;

/**
 * @param {string} text
 * @returns {{ fileHex: string, chainTip: string }}
 */
export function parseSidecar(text) {
  const rawLines = text.split(/\n/);
  const lines = [];
  for (const line of rawLines) {
    const s = line.replace(/\r$/, "");
    if (s.length) lines.push(s);
  }
  if (lines.length !== 2) {
    throw new CliError(1, "sidecar: expected two lines (file hash, chain_tip)");
  }
  const f = lines[0].match(FILE_LINE);
  const t = lines[1].match(TIP_LINE);
  if (!f || !t) {
    throw new CliError(1, "sidecar: malformed lines");
  }
  return { fileHex: f[1].toLowerCase(), chainTip: t[1].toLowerCase() };
}

/**
 * @param {string} fileHex
 * @param {string} chainTip
 */
export function formatSidecar(fileHex, chainTip) {
  return `${fileHex}  evidence.ndjson\nchain_tip  ${chainTip}\n`;
}
