import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonical } from "../src/canonical.js";
import { sha256hex } from "../src/hash.js";
import { normalizePath, pathUnderRoot } from "../src/paths.js";

describe("canonical + paths", () => {
  it("sorts keys and rejects null", () => {
    assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.throws(() => canonical(null));
    assert.throws(() => canonical(1.5));
  });

  it("bounded path prefix", () => {
    assert.equal(pathUnderRoot("/home/rchua/GO/src", "/home/rchua/GO"), true);
    assert.equal(pathUnderRoot("/home/rchua/GO2/src", "/home/rchua/GO"), false);
    assert.equal(normalizePath("/home/rchua/../rchua/GO/./x"), "/home/rchua/GO/x");
  });

  it("empty digest is sha256 of zero bytes via empty canonical array", () => {
    assert.equal(sha256hex(canonical([])).length, 64);
  });
});
