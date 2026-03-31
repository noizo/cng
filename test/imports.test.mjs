import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function extractExports(content) {
  const names = new Set();
  if (/\bexport\s+default\b/.test(content)) names.add("default");
  let m;
  const reFn = /\bexport\s+async\s+function\s+(\w+)|\bexport\s+function\s+(\w+)/g;
  while ((m = reFn.exec(content)) !== null) names.add(m[1] || m[2]);
  const reConst = /\bexport\s+const\s+(\w+)/g;
  while ((m = reConst.exec(content)) !== null) names.add(m[1]);
  const reLet = /\bexport\s+let\s+(\w+)/g;
  while ((m = reLet.exec(content)) !== null) names.add(m[1]);
  const reClass = /\bexport\s+class\s+(\w+)/g;
  while ((m = reClass.exec(content)) !== null) names.add(m[1]);
  const reBrace = /\bexport\s*\{([^}]+)\}/g;
  while ((m = reBrace.exec(content)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function parseNamedImportList(inner) {
  const parts = [];
  let cur = "";
  let depth = 0;
  for (const ch of inner) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map((p) => {
    const bits = p.split(/\s+as\s+/);
    return (bits[0] || "").trim();
  }).filter(Boolean);
}

function extractLocalImports(fromPath, content) {
  const out = [];
  const reNamed = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = reNamed.exec(content)) !== null) {
    const names = parseNamedImportList(m[1]);
    out.push({ from: m[2], names, fromPath });
  }
  const reDef = /\bimport\s+(\w+)\s*from\s*["']([^"']+)["']/g;
  while ((m = reDef.exec(content)) !== null) {
    out.push({ from: m[2], names: ["default"], local: m[1], fromPath });
  }
  const reBoth =
    /\bimport\s+(\w+)\s*,\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  while ((m = reBoth.exec(content)) !== null) {
    out.push({ from: m[3], names: ["default", ...parseNamedImportList(m[2])], fromPath });
  }
  return out;
}

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const withJs = base.endsWith(".js") ? base : `${base}.js`;
  try {
    if (statSync(withJs).isFile()) return withJs;
  } catch {
    /* ignore */
  }
  try {
    if (statSync(base).isFile()) return base;
  } catch {
    /* ignore */
  }
  return null;
}

function buildGraph(jsFiles) {
  const graph = new Map();
  const pathSet = new Set(jsFiles);
  for (const p of jsFiles) graph.set(p, []);
  for (const p of jsFiles) {
    const content = readFileSync(p, "utf8");
    for (const imp of extractLocalImports(p, content)) {
      const target = resolveLocal(imp.fromPath, imp.from);
      if (target && pathSet.has(target)) graph.get(p).push(target);
    }
  }
  return graph;
}

function hasCycle(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  function dfs(u) {
    color.set(u, GRAY);
    for (const v of graph.get(u) || []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  }
  for (const n of graph.keys()) {
    if ((color.get(n) ?? WHITE) === WHITE && dfs(n)) return true;
  }
  return false;
}

describe("imports", () => {
  const jsFiles = walkJs(srcRoot);
  const exportMap = new Map();
  for (const p of jsFiles) {
    exportMap.set(p, extractExports(readFileSync(p, "utf8")));
  }

  it("every local named/default import resolves to an export", () => {
    for (const p of jsFiles) {
      const content = readFileSync(p, "utf8");
      for (const imp of extractLocalImports(p, content)) {
        const target = resolveLocal(imp.fromPath, imp.from);
        if (!target || !target.endsWith(".js")) continue;
        const exports = exportMap.get(target);
        assert(exports, `missing target ${target}`);
        for (const name of imp.names) {
          assert(
            exports.has(name),
            `${p} imports ${name} from ${imp.from} but ${target} does not export it`
          );
        }
      }
    }
  });

  it("index.js imports from every handler module", () => {
    const indexPath = join(srcRoot, "index.js");
    const indexSrc = readFileSync(indexPath, "utf8");
    const handlerDir = join(srcRoot, "handlers");
    const handlers = readdirSync(handlerDir).filter((f) => f.endsWith(".js"));
    for (const h of handlers) {
      const needle = `./handlers/${h}`;
      assert(
        indexSrc.includes(needle),
        `index.js must import from ${needle}`
      );
    }
  });

  it("no import cycles; config.js does not import auth", () => {
    const graph = buildGraph(jsFiles);
    assert.equal(hasCycle(graph), false, "circular imports detected");
    const cfg = readFileSync(join(srcRoot, "config.js"), "utf8");
    assert.equal(
      /\bfrom\s*["']\.\/auth\.js["']/.test(cfg),
      false,
      "config.js must not import auth.js"
    );
  });
});
