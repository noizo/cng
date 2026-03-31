import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "src", "config.js");
const src = readFileSync(configPath, "utf8");

function sliceDefaultConfigObject(text) {
  const key = "export const DEFAULT_CONFIG = ";
  const start = text.indexOf(key);
  assert.ok(start >= 0);
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
  throw new Error("unbalanced DEFAULT_CONFIG");
}

function extractFunctionBody(text, sig) {
  const idx = text.indexOf(sig);
  assert.ok(idx >= 0, `missing ${sig}`);
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

describe("config.js", () => {
  it("DEFAULT_CONFIG has no publicStatus or rpm", () => {
    const block = sliceDefaultConfigObject(src);
    assert.equal(block.includes("publicStatus"), false);
    assert.equal(block.includes("rpm"), false);
  });

  it("loadConfig returns only via cloneConfig", () => {
    const body = extractFunctionBody(src, "export async function loadConfig");
    const retLines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("return "));
    assert.ok(retLines.length >= 1);
    for (const line of retLines) {
      assert.ok(
        line.includes("cloneConfig("),
        `loadConfig return must use cloneConfig: ${line}`
      );
    }
  });

  it("handleSaveConfig wraps KV put in try/catch", () => {
    const body = extractFunctionBody(src, "export async function handleSaveConfig");
    assert.ok(body.includes("try"));
    assert.ok(body.includes("await env.CONFIG.put"));
    assert.ok(body.includes("} catch"));
    assert.ok(body.includes("Failed to persist config"));
  });

  it("setConfigCache only after successful KV write; not in catch; memory path in else", () => {
    const body = extractFunctionBody(src, "export async function handleSaveConfig");
    assert.equal((body.match(/setConfigCache/g) || []).length, 2);
    const catch503 = body.indexOf('{ status: 503 }');
    const firstCache = body.indexOf("setConfigCache");
    assert.ok(catch503 >= 0 && firstCache > catch503);
    assert.ok(
      /if\s*\(\s*env\.CONFIG\s*\)\s*\{[\s\S]*setConfigCache\s*\(/m.test(body)
    );
    assert.ok(/\}\s*else\s*\{[\s\S]*setConfigCache\s*\(/m.test(body));
  });

  it("config cache TTL is 5000ms", () => {
    assert.ok(/_cfgCacheTime\s*<\s*5000/.test(src));
  });

  it("buildRuntimeMaps is exported", () => {
    assert.ok(/^export function buildRuntimeMaps/m.test(src));
  });
});
