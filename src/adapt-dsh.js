import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CliError } from "./errors.js";
import { formatNdjson } from "./evidence.js";
import { sealChain, sha256hex } from "./hash.js";
import { canonical } from "./canonical.js";
import {
  argumentsSha256,
  decodeSessionBytes,
  isoFromEpochMs,
  isOmittedName,
  isSkippedSourceLine,
  mapDshTool,
  mapTurnEndReason,
  resultDigestFromToolResult,
  toolResultCallId,
  toolResultIsError,
  writePathsFromArgs,
} from "./dsh-map.js";
import { formatSidecar } from "./sidecar.js";
import { unzip } from "./zip.js";

/**
 * @param {string} inputPath
 * @param {string} outDir
 * @param {string | undefined} contractPath
 */
export function adaptDsh(inputPath, outDir, contractPath) {
  const input = resolve(inputPath);
  const out = resolve(outDir);
  if (!existsSync(input)) throw new CliError(2, `input not found: ${input}`);

  mkdirSync(out, { recursive: true });
  const outEvidence = join(out, "evidence.ndjson");
  if (existsSync(outEvidence)) {
    throw new CliError(1, "refuse: evidence.ndjson already exists in --out (0.1 has no --force)");
  }

  const outContract = join(out, "contract.md");
  if (existsSync(outContract)) {
    // C4: both present → keep --out bytes; do not copy.
  } else if (contractPath) {
    const src = resolve(contractPath);
    if (!existsSync(src)) throw new CliError(2, `contract not found: ${src}`);
    copyFileSync(src, outContract);
  } else {
    throw new CliError(1, "missing contract.md: pass --contract or place it in --out first");
  }
  if (!existsSync(outContract)) throw new CliError(1, "missing --out/contract.md");

  const contractBytes = readFileSync(outContract);
  const contractSha256 = sha256hex(contractBytes);

  const raw = readFileSync(input);
  const jsonlText = loadSessionJsonl(raw, input);
  const events = adaptSessionJsonl(jsonlText, contractSha256);
  const ndjson = formatNdjson(events);
  const ndjsonBuf = Buffer.from(ndjson, "utf8");
  writeFileSync(outEvidence, ndjsonBuf);
  const tip = events[events.length - 1].hash;
  writeFileSync(join(out, "evidence.ndjson.sha256"), formatSidecar(sha256hex(ndjsonBuf), tip));
  return { out, events };
}

/**
 * @param {Buffer} raw
 * @param {string} inputPath
 */
function loadSessionJsonl(raw, inputPath) {
  const looksZip = raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4b && (raw[2] === 0x03 || raw[2] === 0x05 || raw[2] === 0x07);
  if (looksZip || inputPath.toLowerCase().endsWith(".zip")) {
    let files;
    try {
      files = unzip(raw);
    } catch (e) {
      throw new CliError(1, `invalid zip: ${e.message}`);
    }
    const artifact = pickSessionArtifact(files);
    if (!artifact) throw new CliError(1, "zip has no session.jsonl / session.jsonl.zstd at archive root");
    return decodeSessionBytes(artifact);
  }
  return decodeSessionBytes(raw);
}

/**
 * @param {Map<string, Buffer>} files
 */
function pickSessionArtifact(files) {
  const names = [...files.keys()];
  const root = names.filter((n) => !n.startsWith("subagents/") && !n.startsWith("media/"));
  const preferred = root.find((n) => basename(n) === "session.jsonl.zstd") || root.find((n) => basename(n) === "session.jsonl");
  if (preferred) return files.get(preferred);
  return undefined;
}

/**
 * @param {string} jsonlText
 * @param {string} contractSha256
 */
export function adaptSessionJsonl(jsonlText, contractSha256) {
  const lines = jsonlText.split(/\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw new CliError(1, "session log is empty");

  /** @type {Record<string, unknown>[]} */
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "") continue;
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1) break;
      throw new CliError(1, `session log: invalid JSON on line ${i + 1}`);
    }
  }

  const header = records[0];
  if (!header || header.type !== "session") {
    throw new CliError(1, "first line must be type: session");
  }
  const cwd = typeof header.cwd === "string" ? header.cwd : undefined;
  const sessionId = typeof header.id === "string" ? header.id : undefined;
  const startTs = isoFromEpochMs(header.createdAt);

  /** @type {Set<string>} */
  const omittedIds = new Set();
  /** @type {Map<string, string>} */
  const callNames = new Map();
  /** @type {Record<string, unknown>[]} */
  const payloads = [];

  payloads.push({
    kind: "start",
    ts: startTs,
    contract_sha256: contractSha256,
    harness: "dsh",
    ...(sessionId ? { session_id: sessionId } : {}),
  });

  let lastTurnEnd = null;
  /** @type {Record<string, unknown>[]} */
  const remaining = [];

  for (const rec of records.slice(1)) {
    const type = rec.type;
    if (type === "tool/call") {
      const data = rec.data && typeof rec.data === "object" ? rec.data : {};
      const name = typeof data.name === "string" ? data.name : "";
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (isOmittedName(name)) {
        if (callId) omittedIds.add(callId);
        continue;
      }
      if (rec.ignorable === true) continue;
      remaining.push(rec);
      if (!name || !callId) throw new CliError(1, "tool/call missing name or callId");
      const mapped = mapDshTool(name);
      const ts = isoFromEpochMs(rec.time);
      callNames.set(callId, name);
      /** @type {Record<string, unknown>} */
      const toolCall = {
        kind: "tool_call",
        ts,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "gen_ai.tool.call.id": callId,
        "session_contract.capability": mapped.capability,
        "session_contract.arguments_sha256": argumentsSha256(data.arguments),
        "session_contract.write_paths": mapped.write ? writePathsFromArgs(data.arguments, cwd) : [],
      };
      if (mapped.network) toolCall["session_contract.network"] = true;
      payloads.push(toolCall);
      continue;
    }
    if (type === "tool/result") {
      const callId = toolResultCallId(rec.data);
      if (rec.ignorable === true) continue;
      if (!callId) {
        remaining.push(rec);
        continue;
      }
      if (omittedIds.has(callId)) continue;
      remaining.push(rec);
      const digest = resultDigestFromToolResult(rec.data);
      const isError = toolResultIsError(rec.data);
      const resultSha = sha256hex(canonical({ isError, digest }));
      const nameFromCall = callNames.get(callId);
      payloads.push({
        kind: "tool_result",
        ts: isoFromEpochMs(rec.time),
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": nameFromCall || "unknown",
        "gen_ai.tool.call.id": callId,
        "session_contract.result_sha256": resultSha,
      });
      continue;
    }
    if (type === "turn/end") {
      remaining.push(rec);
      lastTurnEnd = rec;
      continue;
    }
    if (isSkippedSourceLine(rec)) continue;
    remaining.push(rec);
  }

  if (lastTurnEnd && remaining[remaining.length - 1] === lastTurnEnd) {
    const stop = mapTurnEndReason(lastTurnEnd.data && lastTurnEnd.data.reason);
    if (stop) {
      payloads.push({
        kind: "end",
        ts: isoFromEpochMs(lastTurnEnd.time),
        stop_reason: stop,
      });
    }
  }

  return sealChain(payloads);
}
