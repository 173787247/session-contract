/** Spec §3.2 lexical path matching. No symlink policy. */

/**
 * @param {string} p
 */
export function normalizePath(p) {
  let s = String(p).replace(/\\/g, "/");
  const drive = s.match(/^([A-Za-z]:)(\/.*)?$/);
  let prefix = "";
  let rest = s;
  if (drive) {
    prefix = drive[1];
    rest = drive[2] || "/";
  } else if (s.startsWith("/")) {
    prefix = "";
    rest = s;
  }
  const parts = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (drive) return `${prefix}/${parts.join("/")}`;
  if (s.startsWith("/")) return `/${parts.join("/")}`;
  return parts.join("/");
}

/**
 * @param {string} p
 */
export function isAbsolutePath(p) {
  const n = normalizePath(p);
  return n.startsWith("/") || /^[A-Za-z]:\//.test(n);
}

/**
 * @param {string} p
 * @param {string} root
 */
export function pathUnderRoot(p, root) {
  const a = normalizePath(p);
  const b = normalizePath(root);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * @param {string} p
 * @param {string[]} roots
 */
export function pathUnderAnyRoot(p, roots) {
  return roots.some((r) => pathUnderRoot(p, r));
}

/**
 * @param {string} filePath
 * @param {string | undefined} cwd
 */
export function resolveAgainstCwd(filePath, cwd) {
  const raw = String(filePath).replace(/\\/g, "/");
  if (isAbsolutePath(raw)) return normalizePath(raw);
  if (!cwd) return null;
  const base = normalizePath(cwd);
  const joined = base.endsWith("/") ? `${base}${raw}` : `${base}/${raw}`;
  return normalizePath(joined);
}
