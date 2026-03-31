import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const authPath = join(root, "src", "auth.js");
const src = readFileSync(authPath, "utf8");

function extractFunctionBody(text, sig) {
  const idx = text.indexOf(sig);
  assert.ok(idx >= 0);
  const open = text.indexOf("{", idx);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced function");
}

describe("auth.js", () => {
  it("identifyKey uses byteLength for env key timingSafeEqual branches", () => {
    assert.ok(src.includes("a.byteLength === b.byteLength"));
    assert.ok(src.includes("a.byteLength === b2.byteLength"));
  });

  it("user lookup checks cfg.users without requiring env.CONFIG", () => {
    const body = extractFunctionBody(src, "export async function identifyKey");
    assert.ok(body.includes("cfg.users"), "must check cfg.users");
    assert.ok(!body.includes("if (env.CONFIG)"), "must not gate on env.CONFIG");
  });

  it("identifyKey non-null returns are { id, role } objects", () => {
    const body = extractFunctionBody(src, "export async function identifyKey");
    const returns = [];
    const lines = body.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("return ")) returns.push(t);
    }
    for (const r of returns) {
      if (r.includes("return null")) continue;
      assert.ok(r.includes("id:"), `expected id in ${r}`);
      assert.ok(r.includes("role:"), `expected role in ${r}`);
    }
  });

  it("isAdmin checks role === \"admin\"", () => {
    assert.ok(/return\s+auth\?\.role\s*===\s*["']admin["']/.test(src));
  });

  it("hashKey is exported", () => {
    assert.ok(/\bexport\s+async\s+function\s+hashKey\b/.test(src));
  });
});
