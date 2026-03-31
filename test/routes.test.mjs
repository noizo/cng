import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "src", "index.js");
const src = readFileSync(indexPath, "utf8");

describe("routes (index.js)", () => {
  it("pre-auth routes /config and /img/ appear before identifyKey call", () => {
    const cut = src.indexOf("await identifyKey(");
    assert.ok(cut > 0, "identifyKey invocation not found");
    const pConfig = src.indexOf('url.pathname === "/config"');
    const pImg = src.indexOf('url.pathname.startsWith("/img/")');
    assert.ok(pConfig < cut, "/config must be before identifyKey");
    assert.ok(pImg < cut, "/img/ must be before identifyKey");
  });

  it("auth-required /api/* and /v1/* style routes appear after identifyKey", () => {
    const cut = src.indexOf("await identifyKey");
    assert.ok(cut > 0);
    const markers = [
      'url.pathname === "/api/status"',
      'url.pathname === "/v1/models"',
      'url.pathname === "/models"',
      'url.pathname === "/v1/images/generations"',
      'url.pathname.startsWith("/v1/chat/completions")',
    ];
    for (const m of markers) {
      const i = src.indexOf(m);
      assert.ok(i > cut, `${m} must be after identifyKey`);
    }
  });

  it("admin routes use isAdmin(auth)", () => {
    assert.equal(
      (src.match(/if \(!isAdmin\(auth\)\)/g) || []).length,
      6,
      "expected six admin-gated route blocks"
    );
    assert.ok(
      src.includes('url.pathname === "/api/config"') &&
        src.includes('url.pathname === "/api/discover"') &&
        src.includes('url.pathname === "/api/users"')
    );
  });

  it("OpenAI-compatible endpoints exist with /v1/ and bare paths", () => {
    const pairs = [
      ["/v1/chat/completions", "/chat/completions"],
      ["/v1/images/generations", "/images/generations"],
      ["/v1/images/edits", "/images/edits"],
      ["/v1/embeddings", "/embeddings"],
      ["/v1/audio/transcriptions", "/audio/transcriptions"],
      ["/v1/audio/translations", "/audio/translations"],
      ["/v1/audio/speech", "/audio/speech"],
      ["/v1/moderations", "/moderations"],
      ["/v1/translations", "/translations"],
    ];
    for (const [a, b] of pairs) {
      assert.ok(src.includes(a), `missing ${a}`);
      assert.ok(src.includes(b), `missing ${b}`);
    }
  });

  it("models list supports /v1/models and /models", () => {
    assert.ok(
      src.includes('url.pathname === "/v1/models"') &&
        src.includes('url.pathname === "/models"')
    );
  });

  it("unknown paths return 404 JSON", () => {
    assert.ok(
      src.includes("Unknown endpoint") && src.includes("status: 404")
    );
  });

  it("OPTIONS preflight returns 204 with CORS headers", () => {
    assert.ok(src.includes('request.method === "OPTIONS"'), "OPTIONS check missing");
    assert.ok(src.includes("204"), "204 status missing");
  });

  it("CORS_HEADERS constant includes required headers", () => {
    assert.ok(src.includes("Access-Control-Allow-Origin"), "Allow-Origin missing");
    assert.ok(src.includes("Access-Control-Allow-Methods"), "Allow-Methods missing");
    assert.ok(src.includes("Access-Control-Allow-Headers"), "Allow-Headers missing");
  });

  it("withCors wraps all authenticated responses", () => {
    assert.ok(src.includes("withCors(await route())"), "route responses not wrapped with withCors");
  });

  it("rate limiting runs before inference routes", () => {
    assert.ok(src.includes("checkRate"), "checkRate import missing");
    assert.ok(src.includes("inferenceCategory"), "inferenceCategory import missing");
    const rateIdx = src.indexOf("checkRate(auth");
    const routeIdx = src.indexOf("const route = async");
    assert.ok(rateIdx > 0 && rateIdx < routeIdx, "rate check must be before route dispatch");
  });

  it("returns 429 with Retry-After and X-RateLimit headers when rate limited", () => {
    assert.ok(src.includes("status: 429"));
    assert.ok(src.includes("Retry-After"));
    assert.ok(src.includes("X-RateLimit-Limit"));
    assert.ok(src.includes("X-RateLimit-Remaining"));
    assert.ok(src.includes("X-RateLimit-Reset"));
    assert.ok(src.includes("rate_limit_error"));
  });
});
