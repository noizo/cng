import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const res = spawnSync("npx", ["wrangler@3", "deploy", "--dry-run", "--outdir", "dist"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (res.status !== 0) process.exit(res.status ?? 1);

const indexPath = join(dist, "index.js");
if (!existsSync(indexPath)) {
  console.error("missing dist/index.js");
  process.exit(1);
}

let code = readFileSync(indexPath, "utf-8");

const htmlFile = readdirSync(dist).find((f) => f.endsWith(".html"));
if (htmlFile) {
  const html = readFileSync(join(dist, htmlFile), "utf-8");
  const importRegex = new RegExp(
    `import\\s+UI_HTML\\s+from\\s+"\\.\\/` +
    htmlFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    `";`
  );
  const match = code.match(importRegex);
  if (match) {
    code = code.slice(0, match.index)
      + "var UI_HTML = " + JSON.stringify(html) + ";"
      + code.slice(match.index + match[0].length);
  }
}

const outPath = join(dist, "cng.js");
writeFileSync(outPath, code);

const check = spawnSync("node", ["-c", outPath], { stdio: "pipe" });
if (check.status !== 0) {
  console.error("Syntax check failed:", check.stderr?.toString());
  process.exit(1);
}

const st = statSync(outPath);
console.log(`cng.js: ${(st.size / 1024).toFixed(1)} KiB (syntax OK)`);
