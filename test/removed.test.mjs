import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(root, "src");

function walkJs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, acc);
    else if (ent.isFile() && ent.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function sliceDefaultConfigObject(text) {
  const key = "export const DEFAULT_CONFIG = ";
  const start = text.indexOf(key);
  if (start < 0) return null;
  const brace = text.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(brace, i + 1);
    }
  }
  return null;
}

describe("removed legacy surface", () => {
  const files = walkJs(srcRoot);
  const combined = files.map((p) => readFileSync(p, "utf8")).join("\n");

  it("no rateBuckets, checkRateLimit, or renderAsciiStatus in src/", () => {
    assert.equal(combined.includes("rateBuckets"), false);
    assert.equal(combined.includes("checkRateLimit"), false);
    assert.equal(combined.includes("renderAsciiStatus"), false);
  });

  it("DEFAULT_CONFIG has no publicStatus", () => {
    const configPath = join(srcRoot, "config.js");
    const text = readFileSync(configPath, "utf8");
    const block = sliceDefaultConfigObject(text);
    assert.ok(block);
    assert.equal(block.includes("publicStatus"), false);
  });

  it("no /status route (only /api/status)", () => {
    const indexPath = join(srcRoot, "index.js");
    const idx = readFileSync(indexPath, "utf8");
    assert.ok(idx.includes('url.pathname === "/api/status"'));
    assert.equal(
      /\burl\.pathname\s*===\s*["']\/status["']/.test(idx),
      false,
      'must not expose bare GET /status'
    );
    assert.equal(
      /\bpathname\s*===\s*["']\/status["']/.test(idx),
      false
    );
  });

  it("rpm in users.js is via ratelimit module (no legacy rateBuckets)", () => {
    const usersPath = join(srcRoot, "users.js");
    const text = readFileSync(usersPath, "utf8");
    assert.ok(text.includes("resolveLimit"), "rpm should come from ratelimit.js resolveLimit");
    assert.ok(!text.includes("rateBuckets"), "legacy rateBuckets should not exist");
  });
});
