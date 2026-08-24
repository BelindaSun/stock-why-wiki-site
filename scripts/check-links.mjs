import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const DIST = path.join(process.cwd(), "dist");

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".html")) out.push(full);
  }
}

const files = [];
walk(DIST, files);
// The interactive graph under /graph/ is a self-contained page mirrored from
// the content repo; its hrefs are built at runtime (href="${u}"), so skip it.
const checkable = files.filter((f) => !path.relative(DIST, f).startsWith("graph/"));

let brokenCount = 0;
const hrefRe = /href="([^"]+)"/g;

for (const file of checkable) {
  const html = readFileSync(file, "utf-8");
  let m;
  while ((m = hrefRe.exec(html))) {
    let href = m[1];
    if (/^https?:\/\//.test(href) || href.startsWith("mailto:")) continue;
    const [pathPart, hash] = href.split("#");
    if (!pathPart || pathPart === "/") continue;
    const candidate1 = path.join(DIST, pathPart, "index.html");
    const candidate2 = path.join(DIST, pathPart + ".html");
    const candidate3 = path.join(DIST, pathPart);
    if (!existsSync(candidate1) && !existsSync(candidate2) && !existsSync(candidate3)) {
      console.log("BROKEN LINK:", path.relative(DIST, file), "->", href);
      brokenCount++;
    }
  }
}

console.log(`\nChecked ${checkable.length} pages. ${brokenCount} broken internal link(s).`);
process.exit(brokenCount > 0 ? 1 : 0);
