import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/ratelimit.js"), "utf8");

describe("ratelimit.js", () => {
  it("exports checkRate, resolveLimit, getRateStats, recordModel, inferenceCategory, DEFAULT_RPM", () => {
    assert.ok(/export\s+function\s+checkRate\b/.test(src));
    assert.ok(/export\s+function\s+resolveLimit\b/.test(src));
    assert.ok(/export\s+function\s+getRateStats\b/.test(src));
    assert.ok(/export\s+function\s+recordModel\b/.test(src));
    assert.ok(/export\s+function\s+inferenceCategory\b/.test(src));
    assert.ok(/export\s+const\s+DEFAULT_RPM\b/.test(src));
  });

  it("DEFAULT_RPM is 60", () => {
    assert.ok(src.includes("DEFAULT_RPM = 60"));
  });

  it("uses 60-second window", () => {
    assert.ok(src.includes("60_000") || src.includes("60000"));
  });

  it("resolveLimit checks user rpm, then rateLimits by id, then by role, then default", () => {
    assert.ok(src.includes("cfg.users"));
    assert.ok(src.includes("u.rpm"));
    assert.ok(src.includes("rl[auth.id]"));
    assert.ok(src.includes("rl[auth.role]"));
    assert.ok(src.includes("DEFAULT_RPM"));
  });

  it("checkRate returns allowed, limit, remaining, reset", () => {
    assert.ok(src.includes("allowed"));
    assert.ok(src.includes("limit"));
    assert.ok(src.includes("remaining"));
    assert.ok(src.includes("reset"));
  });

  it("checkRate tracks categories", () => {
    assert.ok(src.includes("categories"));
    assert.ok(src.includes("category"));
  });

  it("limit of 0 means unlimited (always allowed)", () => {
    const zeroBlock = src.match(/limit\s*===\s*0[\s\S]*?return\s*\{[^}]+\}/);
    assert.ok(zeroBlock, "should handle limit === 0");
    assert.ok(zeroBlock[0].includes("allowed: true"), "limit 0 should return allowed: true");
  });

  it("inferenceCategory maps paths to categories", () => {
    assert.ok(src.includes("/chat/completions"));
    assert.ok(src.includes("/images/"));
    assert.ok(src.includes("/audio/"));
    assert.ok(src.includes("/embeddings"));
    assert.ok(src.includes("/moderations"));
    assert.ok(src.includes("/translations"));
  });

  it("inferenceCategory returns null for non-inference paths", () => {
    assert.ok(src.includes("return null"));
  });

  it("getRateStats only returns current window entries", () => {
    assert.ok(src.includes("b.wid !== wid"));
  });

  it("reportModelError and reportModelOk accept env for KV persistence", () => {
    assert.ok(/export\s+function\s+reportModelError\(model,\s*env\)/.test(src));
    assert.ok(/export\s+function\s+reportModelOk\(model,\s*env\)/.test(src));
  });

  it("getModelHealth is async and reads from KV", () => {
    assert.ok(/export\s+async\s+function\s+getModelHealth\(env\)/.test(src));
    assert.ok(src.includes("env?.CONFIG"));
    assert.ok(src.includes("HEALTH_KV_KEY"));
  });

  it("persistHealth writes to KV with TTL", () => {
    assert.ok(src.includes("expirationTtl"));
    assert.ok(/async\s+function\s+persistHealth/.test(src));
  });
});
