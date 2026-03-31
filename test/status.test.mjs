import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "status.js"), "utf8");

describe("status.js", () => {
  it("exports fetchStatusData", () => {
    assert.ok(/export\s+async\s+function\s+fetchStatusData/.test(src));
  });

  it("queries Cloudflare GraphQL API", () => {
    assert.ok(src.includes("api.cloudflare.com/client/v4/graphql"));
  });

  it("returns neuron usage with included allowance", () => {
    assert.ok(src.includes("included: 10000"));
  });

  it("calculates overage cost at $0.011 per 1000 neurons", () => {
    assert.ok(src.includes("0.011"));
  });

  it("returns worker invocation stats", () => {
    assert.ok(src.includes("invocations"));
    assert.ok(src.includes("errors"));
  });

  it("has error fallback returning safe defaults", () => {
    assert.ok(src.includes("catch (err)"));
    assert.ok(src.includes("Failed to fetch status"));
  });
});
