import { parseDocument, visit } from "yaml";
import { CliError } from "./errors.js";

const OPEN = /^`{3,}([^`\r\n]*)[ \t]*\r?$/;
const CLOSE = /^`{3,}[ \t]*\r?$/;

function lineEnd(text, offset, line, isLast) {
  const hasNl = !isLast || text.endsWith("\n") || text.endsWith("\r\n");
  return offset + line.length + (hasNl ? 1 : 0);
}

/**
 * Unindented markdown fences only. Indented ``` inside a YAML block scalar stays in the body.
 * Opening fence may carry an info string (`yaml`, `js`, …). A closing fence is backticks only.
 * @param {string} text
 * @returns {{ start: number, end: number, openLine: string, body: string, closeFound: boolean }[]}
 */
export function unindentedFences(text) {
  const lines = text.split(/\n/);
  const fences = [];
  let i = 0;
  let offset = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineStart = offset;
    if (OPEN.test(line)) {
      i += 1;
      offset += line.length + 1;
      const bodyStart = offset;
      let closeFound = false;
      while (i < lines.length) {
        if (CLOSE.test(lines[i])) {
          closeFound = true;
          const body = text.slice(bodyStart, offset);
          const end = lineEnd(text, offset, lines[i], i === lines.length - 1);
          fences.push({
            start: lineStart,
            end: Math.min(end, text.length),
            openLine: line,
            body: body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
            closeFound,
          });
          offset += lines[i].length + 1;
          i += 1;
          break;
        }
        offset += lines[i].length + 1;
        i += 1;
      }
      if (!closeFound) {
        fences.push({
          start: lineStart,
          end: text.length,
          openLine: line,
          body: text.slice(bodyStart).replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
          closeFound: false,
        });
      }
      continue;
    }
    offset += line.length + 1;
    i += 1;
  }
  return fences;
}

/**
 * @param {string} body
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseRestrictedYaml(body) {
  if (/^\s*$/.test(body)) return { ok: false, error: "empty yaml" };
  const doc = parseDocument(body, { maxAliasCount: 0, prettyErrors: true });
  if (doc.errors.length) {
    return { ok: false, error: doc.errors[0].message };
  }
  let tagOrAnchor = false;
  visit(doc, {
    Pair() {},
    Node(key, node) {
      if (node && typeof node === "object" && "anchor" in node && node.anchor) tagOrAnchor = true;
      if (node && typeof node === "object" && "tag" in node && node.tag && node.tag !== "!") {
        const tag = String(node.tag);
        if (tag !== "tag:yaml.org,2002:str" && tag !== "tag:yaml.org,2002:int" && tag !== "tag:yaml.org,2002:bool" && tag !== "tag:yaml.org,2002:map" && tag !== "tag:yaml.org,2002:seq" && tag !== "tag:yaml.org,2002:null") {
          tagOrAnchor = true;
        }
      }
    },
  });
  if (tagOrAnchor) return { ok: false, error: "yaml anchors, aliases, and tags are forbidden" };
  const value = doc.toJS({ mapAsMap: false });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "yaml root must be a mapping" };
  }
  return { ok: true, value };
}

function looksLikeClaim(body) {
  return /(?:^|\n)[ \t]*role:[ \t]*claim(?:\s|$)/.test(body) && /(?:^|\n)[ \t]*session_contract:[ \t]*["']?0\.1["']?/.test(body);
}

function looksLikeContract(body) {
  return /(?:^|\n)[ \t]*session_contract:[ \t]*["']?0\.1["']?/.test(body);
}

/**
 * @param {string} markdown
 */
export function findClaimFence(markdown) {
  const fences = unindentedFences(markdown);
  /** @type {{ fence: typeof fences[0], parsed: Record<string, unknown> | null }[]} */
  const matches = [];
  for (const fence of fences) {
    const parsed = parseRestrictedYaml(fence.body);
    if (parsed.ok && parsed.value.role === "claim" && String(parsed.value.session_contract) === "0.1") {
      matches.push({ fence, parsed: parsed.value });
      continue;
    }
    if (!parsed.ok && looksLikeClaim(fence.body)) {
      matches.push({ fence, parsed: null });
    }
  }
  if (matches.length > 1) {
    throw new CliError(1, "multiple claim fences in verdict.md");
  }
  return matches[0] ?? null;
}

/**
 * @param {string} markdown
 */
export function findContractFence(markdown) {
  const fences = unindentedFences(markdown);
  const matches = [];
  for (const fence of fences) {
    const parsed = parseRestrictedYaml(fence.body);
    if (parsed.ok && String(parsed.value.session_contract) === "0.1" && parsed.value.role !== "claim") {
      matches.push({ fence, parsed: parsed.value });
    } else if (!parsed.ok && looksLikeContract(fence.body) && !looksLikeClaim(fence.body)) {
      matches.push({ fence, parsed: null });
    }
  }
  if (matches.length === 0) {
    throw new CliError(1, "contract.md: missing session_contract 0.1 yaml fence");
  }
  if (matches.length > 1) {
    throw new CliError(1, "contract.md: multiple session_contract 0.1 yaml fences");
  }
  const hit = matches[0];
  if (!hit.parsed) {
    throw new CliError(1, "contract.md: yaml fence does not parse");
  }
  return hit;
}

/**
 * @param {string} s
 */
export function yamlDoubleQuoted(s) {
  return JSON.stringify(s);
}
