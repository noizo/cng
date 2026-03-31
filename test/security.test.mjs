import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

describe("XSS prevention in ui.html", () => {
  const src = read("src/ui.html");

  it("esc() function exists and escapes all five HTML entities", () => {
    assert.ok(src.includes("function esc("));
    assert.ok(src.includes("&amp;"));
    assert.ok(src.includes("&lt;"));
    assert.ok(src.includes("&gt;"));
    assert.ok(src.includes("&quot;"));
    assert.ok(src.includes("&#39;"));
  });

  it("w.name is escaped before innerHTML insertion", () => {
    assert.ok(src.includes("esc(w.name)"));
  });

  it("m.kind values are escaped in all model card locations", () => {
    const kindBadges = [...src.matchAll(/d-badge kind">\'\+(.+?)\+\'/g)];
    for (const match of kindBadges) {
      assert.ok(
        match[1].includes("esc("),
        `Unescaped m.kind in badge: ${match[0]}`
      );
    }
  });

  it("a.type is escaped in alias badge", () => {
    assert.ok(src.includes('esc(a.type)'));
  });

  it("user role is escaped in user card", () => {
    assert.ok(
      src.includes("esc(u.role||'client')") || src.includes('esc(u.role||"client")'),
      "user role must be escaped via esc()"
    );
  });
});

describe("GraphQL injection prevention in status.js", () => {
  const src = read("src/status.js");

  it("WORKER_NAME is sanitized to alphanumeric, dash, underscore only", () => {
    const sanitizePattern = /[^a-zA-Z0-9_-]/;
    assert.ok(src.includes('[^a-zA-Z0-9_-]'));
  });

  it("sanitization applies in both success and error paths", () => {
    const needle = '/[^a-zA-Z0-9_-]/g';
    let count = 0, idx = 0;
    while ((idx = src.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
    assert.ok(count >= 2, `expected sanitization in both paths, found ${count}`);
  });
});

describe("Content-Security-Policy on /config", () => {
  const src = read("src/index.js");

  it("/config response includes CSP header", () => {
    assert.ok(src.includes("Content-Security-Policy"));
  });

  it("CSP blocks framing (frame-ancestors 'none')", () => {
    assert.ok(src.includes("frame-ancestors 'none'"));
  });

  it("/config response includes Referrer-Policy: no-referrer", () => {
    assert.ok(src.includes("Referrer-Policy"));
    assert.ok(src.includes("no-referrer"));
  });
});

describe("/api/status requires admin", () => {
  const src = read("src/index.js");

  it("/api/status is gated with isAdmin(auth)", () => {
    const statusIdx = src.indexOf('url.pathname === "/api/status"');
    assert.ok(statusIdx > 0);
    const block = src.slice(statusIdx, statusIdx + 200);
    assert.ok(block.includes("isAdmin(auth)"), "/api/status must be admin-gated");
  });
});

describe("image maxDim from config", () => {
  const imgSrc = read("src/handlers/images.js");
  const cfgSrc = read("src/config.js");

  it("buildRuntimeMaps exposes maxDimMap", () => {
    assert.ok(cfgSrc.includes("maxDimMap"));
  });

  it("image handler uses rt.maxDimMap for dimension clamping", () => {
    assert.ok(imgSrc.includes("rt.maxDimMap"));
    assert.ok(imgSrc.includes("rt.maxDimMap[model]"));
  });
});

describe("users.js update action", () => {
  const src = read("src/users.js");

  it("update action modifies user fields before persisting", () => {
    const updateStart = src.indexOf('body.action === "update"');
    const updateBlock = src.slice(updateStart, updateStart + 500);
    assert.ok(updateBlock.includes("user.role"), "update should modify user.role");
    assert.ok(updateBlock.includes("body.role"), "update should read body.role");
  });

  it("update action validates role values", () => {
    assert.ok(src.includes('["admin", "client"].includes(body.role)'));
  });
});
