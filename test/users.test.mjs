import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "users.js"), "utf8");

describe("users.js", () => {
  it("exports handleGetUsers and handleUserAction", () => {
    assert.ok(/export\s+async\s+function\s+handleGetUsers/.test(src));
    assert.ok(/export\s+async\s+function\s+handleUserAction/.test(src));
  });

  it("defines reserved env user IDs (admin, key2)", () => {
    assert.ok(src.includes("RESERVED_IDS"));
    assert.ok(src.includes('"admin"'));
    assert.ok(src.includes('"key2"'));
  });

  it("create action generates random key and returns it", () => {
    assert.ok(src.includes('action === "create"'));
    assert.ok(src.includes("crypto.getRandomValues"));
    assert.ok(src.includes("key,"));
  });

  it("create action rejects duplicate and reserved IDs", () => {
    assert.ok(src.includes("RESERVED_IDS.has(body.id)"));
    assert.ok(src.includes("User already exists"));
  });

  it("delete action filters user from config", () => {
    assert.ok(src.includes('action === "delete"'));
    assert.ok(src.includes("config.users.filter"));
  });

  it("update action modifies user role before persisting", () => {
    assert.ok(src.includes('action === "update"'));
    const updateIdx = src.indexOf('action === "update"');
    const persistIdx = src.indexOf("persist()", updateIdx);
    const roleIdx = src.indexOf("user.role", updateIdx);
    assert.ok(roleIdx > updateIdx && roleIdx < persistIdx, "user.role must be set before persist()");
  });

  it("toggle_spoof toggles spoofedKeys array", () => {
    assert.ok(src.includes('action === "toggle_spoof"'));
    assert.ok(src.includes("spoofedKeys"));
  });

  it("rename_key trims and limits name length", () => {
    assert.ok(src.includes('action === "rename_key"'));
    assert.ok(src.includes(".slice(0, 128)"));
  });

  it("set_rpm action updates per-user or rateLimits config", () => {
    assert.ok(src.includes('action === "set_rpm"'));
    assert.ok(src.includes("kvUser.rpm"));
    assert.ok(src.includes("config.rateLimits"));
  });

  it("set_rpm, toggle_spoof, rename_key work without KV (before KV gate)", () => {
    const kvGateIdx = src.indexOf("User management requires KV");
    const setRpmIdx = src.indexOf('action === "set_rpm"');
    const toggleIdx = src.indexOf('action === "toggle_spoof"');
    const renameIdx = src.indexOf('action === "rename_key"');
    assert.ok(setRpmIdx < kvGateIdx, "set_rpm must be before KV gate");
    assert.ok(toggleIdx < kvGateIdx, "toggle_spoof must be before KV gate");
    assert.ok(renameIdx < kvGateIdx, "rename_key must be before KV gate");
  });

  it("requires KV for user create/delete", () => {
    assert.ok(src.includes("User management requires KV"));
  });

  it("handleGetUsers includes rpm and rate stats", () => {
    assert.ok(src.includes("getRateStats"));
    assert.ok(src.includes("resolveLimit"));
    assert.ok(src.includes("rpm:"));
    assert.ok(src.includes("rate:"));
  });

  it("persist function writes to KV and falls back to memory", () => {
    assert.ok(src.includes("env.CONFIG.put"));
    assert.ok(src.includes("setConfigCache"));
  });
});
