/** RFC 8259 JSON with sorted object keys and no insignificant whitespace. Spec §4.4. */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("canonical: number must be a safe integer");
    }
    return String(value);
  }
  if (value === null || t === "undefined") {
    throw new TypeError("canonical: null/undefined forbidden");
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (t === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonical: unsupported type ${t}`);
}

/**
 * Recursively assert spec §4.1 value types. Returns the same value.
 * @param {unknown} value
 * @param {string} [path]
 */
export function assertJsonValue(value, path = "$") {
  if (value === null) throw new TypeError(`${path}: null forbidden`);
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${path}: number must be a safe integer`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonValue(v, `${path}[${i}]`));
    return value;
  }
  if (t === "object") {
    for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${path}.${k}`);
    return value;
  }
  throw new TypeError(`${path}: unsupported type ${t}`);
}
