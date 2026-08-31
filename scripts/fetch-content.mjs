import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", ".content-cache");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const REPO_URL = "https://github.com/BelindaSun/stock-why-wiki.git";

const force = process.argv.includes("--force");

// The content repo ships the interactive graph pages plus their shared assets.
// Mirror them into public/graph/ so they live on this site's own domain at
// /graph/ and refreshes on every rebuild, instead of pointing readers off to
// the separate GitHub Pages deployment.
function syncGraph() {
  const src = path.join(CACHE_DIR, "index.html");
  if (!existsSync(src)) {
    console.warn("[fetch-content] no index.html in content repo, skipping graph mirror");
    return;
  }
  const destDir = path.join(PUBLIC_DIR, "graph");
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, path.join(destDir, "index.html"));
  // graph.html is an alternate view the content repo also ships; mirror it too
  // if present so any in-graph link to it keeps working.
  const alt = path.join(CACHE_DIR, "graph.html");
  if (existsSync(alt)) copyFileSync(alt, path.join(destDir, "graph.html"));
  const biotech = path.join(CACHE_DIR, "graph-biotech.html");
  if (existsSync(biotech)) copyFileSync(biotech, path.join(destDir, "biotech.html"));
  for (const asset of ["i18n.js", "i18n-en.json"]) {
    const assetSrc = path.join(CACHE_DIR, asset);
    if (existsSync(assetSrc)) copyFileSync(assetSrc, path.join(destDir, asset));
  }
  console.log("[fetch-content] mirrored interactive graph -> public/graph/");
}

if (existsSync(CACHE_DIR)) {
  if (force) {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  } else {
    console.log("[fetch-content] .content-cache exists, refreshing via git pull");
    try {
      execSync("git pull --ff-only", { cwd: CACHE_DIR, stdio: "inherit" });
      syncGraph();
      process.exit(0);
    } catch (e) {
      console.warn("[fetch-content] pull failed, re-cloning:", e.message);
      rmSync(CACHE_DIR, { recursive: true, force: true });
    }
  }
}

console.log("[fetch-content] cloning", REPO_URL);
execSync(`git clone --depth 1 ${REPO_URL} "${CACHE_DIR}"`, { stdio: "inherit" });
syncGraph();
