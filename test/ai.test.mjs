import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = read("src/ai.js");

describe("ai.js", () => {
  it("exports runModel, runModelStream, runModelRaw, runModelBinary, runImageJson, runImageMultipart, AIError", () => {
    assert.ok(/export\s+async\s+function\s+runModel\b/.test(src));
    assert.ok(/export\s+async\s+function\s+runModelStream\b/.test(src));
    assert.ok(/export\s+async\s+function\s+runModelRaw\b/.test(src));
    assert.ok(/export\s+async\s+function\s+runModelBinary\b/.test(src));
    assert.ok(/export\s+async\s+function\s+runImageJson\b/.test(src));
    assert.ok(/export\s+async\s+function\s+runImageMultipart\b/.test(src));
    assert.ok(src.includes("export { AIError }"));
  });

  it("does not export runModelForm (removed dead code)", () => {
    assert.ok(!src.includes("runModelForm"));
  });

  it("checks env.AI before falling back to REST for every exported function", () => {
    const fns = ["runModel", "runModelStream", "runModelRaw", "runModelBinary", "runImageJson", "runImageMultipart"];
    for (const fn of fns) {
      const fnMatch = src.match(new RegExp(`export async function ${fn}[\\s\\S]*?^}`, "m"));
      assert.ok(fnMatch, `${fn} not found`);
      assert.ok(fnMatch[0].includes("env.AI"), `${fn} does not check env.AI`);
    }
  });

  it("REST fallback uses restUrl with fixed api.cloudflare.com host", () => {
    const hostMatches = src.match(/https:\/\/[^"'\s`]+/g) || [];
    assert.ok(hostMatches.length > 0, "no REST URLs found in source");
    for (const url of hostMatches) {
      const parsed = new URL(url);
      assert.strictEqual(parsed.origin, "https://api.cloudflare.com", `unexpected host: ${url}`);
    }
    assert.ok(
      hostMatches.some(u => new URL(u).pathname.startsWith("/client/v4/accounts/")),
      "no URL with /client/v4/accounts/ path found"
    );
  });

  it("validates model parameter against safe charset before REST calls", () => {
    assert.ok(src.includes("MODEL_PATH_RE"));
    assert.ok(src.includes("validateModel"));
    assert.ok(src.includes("Invalid model identifier"));
  });

  it("model validation regex allows @cf/ paths and rejects traversal", () => {
    const reMatch = src.match(/MODEL_PATH_RE\s*=\s*(\/.*?\/[a-z]*)\s*;/);
    assert.ok(reMatch, "MODEL_PATH_RE not found");
    const re = eval(reMatch[1]);
    assert.ok(re.test("@cf/meta/llama-3.1-8b-instruct"), "should allow standard model path");
    assert.ok(re.test("@cf/openai/whisper-large-v3-turbo"), "should allow whisper model");
    assert.ok(!re.test(""), "should reject empty string");
    assert.ok(!re.test("model with spaces"), "should reject spaces");
    assert.ok(!re.test("model?query=1"), "should reject query strings");
    assert.ok(!re.test("model#fragment"), "should reject fragments");
  });

  it("never exposes CF_API_TOKEN in error messages", () => {
    const errorThrows = src.match(/throw new AIError\([^)]+\)/g) || [];
    for (const t of errorThrows) {
      assert.ok(!t.includes("CF_API_TOKEN"), `token may leak in: ${t}`);
      assert.ok(!t.includes("Authorization"), `auth header may leak in: ${t}`);
    }
  });

  it("stream error uses safeErrorMessage instead of raw upstream body", () => {
    assert.ok(src.includes("safeErrorMessage"));
    const streamFn = src.match(/export async function runModelStream[\s\S]*?^}/m);
    assert.ok(streamFn, "runModelStream not found");
    assert.ok(streamFn[0].includes("safeErrorMessage"), "stream errors should use safeErrorMessage");
    assert.ok(!streamFn[0].match(/throw new AIError\(text\b/), "should not throw raw text as error");
  });

  it("binary error uses safeErrorMessage instead of raw upstream body", () => {
    const binaryFn = src.match(/export async function runModelBinary[\s\S]*?^}/m);
    assert.ok(binaryFn, "runModelBinary not found");
    assert.ok(binaryFn[0].includes("safeErrorMessage"), "binary errors should use safeErrorMessage");
  });

  it("runModelRaw does not spread large audio arrays (no [...new Uint8Array])", () => {
    assert.ok(!src.includes("[...new Uint8Array"), "should not spread Uint8Array into array for audio binding");
  });

  it("image functions return imageBytes (Uint8Array) not _raw sentinel", () => {
    assert.ok(!src.includes("_raw"), "should not use _raw sentinel");
    assert.ok(src.includes("imageBytes"), "should use imageBytes for normalized image results");
  });

  it("AIError class has status property", () => {
    assert.ok(src.includes("this.status = status || 502"));
  });

  it("toUint8Array handles ReadableStream, ArrayBuffer, and Uint8Array", () => {
    assert.ok(src.includes("async function toUint8Array"));
    assert.ok(src.includes("instanceof Uint8Array"));
    assert.ok(src.includes("instanceof ArrayBuffer"));
    assert.ok(src.includes("instanceof ReadableStream"));
  });
});
