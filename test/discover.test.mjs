import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "discover.js"), "utf8");

describe("discover.js", () => {
  it("exports handleDiscover, TASK_MAP, TASK_KIND", () => {
    assert.ok(/export\s+async\s+function\s+handleDiscover/.test(src));
    assert.ok(/export\s+const\s+TASK_MAP/.test(src));
    assert.ok(/export\s+const\s+TASK_KIND/.test(src));
  });

  it("queries Cloudflare model catalog API", () => {
    assert.ok(src.includes("ai/models/search"));
  });

  it("maps task types to model categories", () => {
    assert.ok(src.includes('"Text Generation"'));
    assert.ok(src.includes('"Text-to-Image"'));
    assert.ok(src.includes('"Automatic Speech Recognition"'));
    assert.ok(src.includes('"Text-to-Speech"'));
    assert.ok(src.includes('"Text Embeddings"'));
  });

  it("tracks existing models to avoid duplicates", () => {
    assert.ok(src.includes("existingPaths"));
    assert.ok(src.includes("existing:"));
  });

  it("sorts discovered models (existing last, beta last, deprecated last)", () => {
    assert.ok(src.includes("models.sort"));
    assert.ok(src.includes("a.existing"));
    assert.ok(src.includes("a.beta"));
    assert.ok(src.includes("a.deprecated"));
  });
});
