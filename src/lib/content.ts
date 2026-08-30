import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { toString as mdastToString } from "mdast-util-to-string";

const CACHE_DIR = path.join(process.cwd(), ".content-cache");

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export interface TimelineEvent {
  date: string;
  summary: string;
}

export interface WikiDoc {
  /** slug relative to site root, e.g. "stocks/NVDA" or "industries/semiconductors" or "overview" */
  slug: string;
  /** absolute path in the cloned repo */
  filePath: string;
  /** folder the file lives in, relative to repo root: "stocks", "industries", or "" for root */
  dir: string;
  title: string;
  /** e.g. "stock" / "ETF" / "crypto" / "commodity" — only stock files carry this */
  assetType: string | null;
  updatedLine: string | null;
  /** industry files carry a one-line trend note in the meta line */
  trend: string | null;
  /** newest move (from the timeline) — used for cards + the article highlight */
  latestEvent: TimelineEvent | null;
  highlight: string | null;
  highlightHtml: string | null;
  html: string;
  headings: Heading[];
  raw: string;
}

export interface CategoryMeta {
  key: string;
  label: string;
  icon: string;
  description: string;
}

// The two content buckets of the wiki. `stocks/` = one file per asset with a
// timeline of moves; `industries/` = one file per theme that back-links the
// assets touching it.
export const CATEGORIES: CategoryMeta[] = [
  { key: "stocks", label: "个股 · 涨跌溯源", icon: "📈", description: "每只资产一份档案：上游（谁驱动它）· 下游（它影响谁）· 时间线（每次涨跌 + 真实催化剂）" },
  { key: "industries", label: "行业 · 主题", icon: "🏭", description: "把个股连成产业链的主题节点：相关标的、趋势、待补的链条" },
];

// Root-level markdown that IS worth rendering as a page (everything else at the
// repo root — README, chatgpt-custom-gpt, skill/ — is repo plumbing, skipped).
const ROOT_PAGES = new Set(["index.md", "overview.md", "healthcare-overview.md"]);

function slugForFile(repoRelativePath: string): string {
  return repoRelativePath.replace(/\.md$/i, "").replace(/\\/g, "/");
}

function walk(dir: string, base: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, path.join(base, entry), out);
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push(path.join(base, entry));
    }
  }
}

/** Which repo-relative .md files become site pages. */
function isRenderable(repoRelativePath: string): boolean {
  const norm = repoRelativePath.replace(/\\/g, "/");
  if (norm.startsWith("stocks/") || norm.startsWith("industries/")) return true;
  return ROOT_PAGES.has(norm);
}

interface LinkContext {
  tickers: Set<string>;
  industries: Set<string>;
}

/** Turns the wiki's own `[[TICKER]]` / `[[industry:slug]]` cross-links into real
 * site links when the target file exists, and into plain text otherwise (so a
 * link to an asset we haven't mapped yet doesn't dead-end on a 404). Runs on the
 * raw markdown string before it's handed to the markdown processor. */
function replaceWikiLinks(text: string, ctx: LinkContext): string {
  return text
    .replace(/\[\[industry:([a-z0-9-]+)\]\]/gi, (_m, slug: string) =>
      ctx.industries.has(slug) ? `[${slug}](/industries/${slug})` : slug
    )
    .replace(/\[\[([^\]]+)\]\]/g, (_m, name: string) => {
      const key = name.trim();
      return ctx.tickers.has(key) ? `[${key}](/stocks/${key})` : key;
    });
}

/** Rewrites relative .md links (with optional #anchor) into site-absolute
 * routes, resolved relative to the linking file's directory. */
function rewriteLinks() {
  return (tree: any, file: any) => {
    const fileDir: string = file.data.dir ?? "";
    visit(tree, "link", (node: any) => {
      const url: string = node.url || "";
      if (/^https?:\/\//i.test(url) || url.startsWith("mailto:")) return;
      const [pathPart, anchor] = url.split("#");
      if (!pathPart) return;
      // The content repo's own links to its interactive graph (graph.html /
      // index.html at the repo root) point at the copy we mirror into
      // /graph/ — retarget them there so they don't dead-end.
      const lower = pathPart.toLowerCase();
      if (lower === "graph.html" || lower === "./graph.html") {
        node.url = "/graph/graph.html" + (anchor ? `#${anchor}` : "");
        return;
      }
      if (lower === "index.html" || lower === "./index.html") {
        node.url = "/graph/index.html" + (anchor ? `#${anchor}` : "");
        return;
      }
      if (!lower.endsWith(".md")) return;
      const resolved = path.posix.normalize(path.posix.join(fileDir, pathPart));
      let route = resolved.replace(/\.md$/i, "");
      route = route.endsWith("/index") ? route.slice(0, -"index".length) : route;
      node.url = "/" + route + (anchor ? `#${anchor}` : "");
    });
  };
}

/** Timeline headings start with an ISO date (`## 2026-08-24 — …`). Give those a
 * clean `id` that is *just the date*, so other pages (e.g. the investment-book
 * timeline) can deep-link to a specific move as `/stocks/GOOGL#2026-08-24`
 * instead of having to know the full slugified heading text. Falls through to
 * null for non-timeline headings. `seen` dedupes a date repeated within one
 * file (second one becomes `2026-08-24-2`). */
function dateAnchor(text: string, seen: Set<string>): string | null {
  const m = text.trim().match(/^(\d{4}-\d{2}-\d{2})\b/);
  if (!m) return null;
  let id = m[1];
  if (seen.has(id)) {
    let n = 2;
    while (seen.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  seen.add(id);
  return id;
}

/** Flattens a hast element's text content (rehype has no shared toString). */
function hastText(node: any): string {
  if (node.type === "text") return node.value || "";
  if (node.children) return node.children.map(hastText).join("");
  return "";
}

/** Runs after rehypeSlug and rewrites timeline date headings to a bare-date id,
 * keeping the rendered anchors in lockstep with the TOC (see dateAnchor). */
function rehypeDateAnchors() {
  return (tree: any) => {
    const seen = new Set<string>();
    visit(tree, "element", (node: any) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      const id = dateAnchor(hastText(node), seen);
      if (!id) return;
      node.properties = node.properties || {};
      node.properties.id = id;
    });
  };
}

function extractHeadings(tree: any): Heading[] {
  const headings: Heading[] = [];
  const seenDates = new Set<string>();
  visit(tree, "heading", (node: any) => {
    if (node.depth < 2 || node.depth > 3) return;
    const text = mdastToString(node);
    const id = dateAnchor(text, seenDates) || (node.data && node.data.id) || slugify(text);
    headings.push({ depth: node.depth, text, id });
  });
  return headings;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkCjkFriendly)
  .use(rewriteLinks)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSlug)
  .use(rehypeDateAnchors)
  .use(rehypeStringify);

const inlineProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkCjkFriendly)
  .use(rewriteLinks)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeStringify);

function renderInline(text: string, dir: string): string {
  const tree = inlineProcessor.parse(text);
  const hastTree = inlineProcessor.runSync(tree, { data: { dir } } as any);
  const html = inlineProcessor.stringify(hastTree as any);
  return html.replace(/^<p>/, "").replace(/<\/p>\n?$/, "");
}

export function stripMd(text: string): string {
  return text
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function parseDoc(repoRelativePath: string, ctx: LinkContext): WikiDoc {
  const filePath = path.join(CACHE_DIR, repoRelativePath);
  const raw = readFileSync(filePath, "utf-8");
  const dir = path.posix.dirname(repoRelativePath.replace(/\\/g, "/"));
  const normDir = dir === "." ? "" : dir;

  const lines = raw.split("\n");

  // Title = first `# ` heading.
  let title = repoRelativePath;
  let titleLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+)$/);
    if (m) {
      title = m[1].trim();
      titleLineIdx = i;
      break;
    }
  }

  // Meta line right under the title: `_Asset type: stock_ · _Last updated: …_`
  // (stocks) or `_Last updated: …_ · _趋势：…_` (industries).
  let assetType: string | null = null;
  let updatedLine: string | null = null;
  let trend: string | null = null;
  let metaLineIdx = -1;
  if (titleLineIdx >= 0 && titleLineIdx + 1 < lines.length) {
    const cand = lines[titleLineIdx + 1].trim();
    if (/^_.+_/.test(cand) && /(Asset type|Last updated|趋势)/.test(cand)) {
      metaLineIdx = titleLineIdx + 1;
      const at = cand.match(/Asset type:\s*(.+?)_/);
      if (at) assetType = at[1].trim();
      const up = cand.match(/Last updated:\s*(.+?)_/);
      if (up) updatedLine = up[1].trim();
      const tr = cand.match(/趋势[：:]\s*(.+?)_/);
      if (tr) trend = tr[1].trim();
    }
  }

  // Newest move, from the first `## YYYY-MM-DD — …` timeline heading.
  let latestEvent: TimelineEvent | null = null;
  const evMatch = raw.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+[—-]\s+(.+)$/m);
  if (evMatch) latestEvent = { date: evMatch[1], summary: evMatch[2].trim() };

  // Industry files open with a `一句话：…` one-liner — pull it out as the
  // highlight and strip it from the body so it isn't shown twice.
  let oneLinerIdx = -1;
  let oneLiner: string | null = null;
  const startBody = (metaLineIdx >= 0 ? metaLineIdx : titleLineIdx) + 1;
  for (let i = startBody; i < Math.min(lines.length, startBody + 6); i++) {
    const m = lines[i].match(/^一句话[：:]\s*(.+)$/);
    if (m) {
      oneLiner = m[1].trim();
      oneLinerIdx = i;
      break;
    }
    if (lines[i].trim() !== "") break;
  }

  // Highlight: industries → the 一句话 note; stocks → the latest move.
  let highlight: string | null = null;
  if (oneLiner) {
    highlight = oneLiner;
  } else if (latestEvent) {
    highlight = `**${latestEvent.date}** · ${latestEvent.summary}`;
  }
  const highlightHtml = highlight
    ? renderInline(replaceWikiLinks(highlight, ctx), normDir)
    : null;

  // Body = everything after the title + meta line, minus the extracted one-liner.
  const skip = new Set<number>();
  if (titleLineIdx >= 0) skip.add(titleLineIdx);
  if (metaLineIdx >= 0) skip.add(metaLineIdx);
  if (oneLinerIdx >= 0) skip.add(oneLinerIdx);
  const bodyLines = titleLineIdx >= 0 ? lines.filter((_, i) => i > titleLineIdx && !skip.has(i)) : lines;
  const bodyRaw = replaceWikiLinks(bodyLines.join("\n").replace(/^\s*\n+/, ""), ctx);

  const tree = processor.parse(bodyRaw);
  (tree as any).data = { dir: normDir };
  const headings = extractHeadings(tree);
  const hastTree = processor.runSync(tree, { data: { dir: normDir } } as any);
  const html = processor.stringify(hastTree as any);

  return {
    slug: slugForFile(repoRelativePath),
    filePath,
    dir: normDir,
    title,
    assetType,
    updatedLine,
    trend,
    latestEvent,
    highlight,
    highlightHtml,
    html,
    headings,
    raw,
  };
}

let _cache: WikiDoc[] | null = null;

export function getAllDocs(): WikiDoc[] {
  if (_cache) return _cache;
  if (!existsSync(CACHE_DIR)) {
    throw new Error(
      "Content cache not found. Run `npm run fetch-content` before building/dev."
    );
  }
  const files: string[] = [];
  walk(CACHE_DIR, "", files);
  const renderable = files.filter((f) => isRenderable(f));

  const ctx: LinkContext = {
    tickers: new Set(
      renderable
        .filter((f) => f.replace(/\\/g, "/").startsWith("stocks/"))
        .map((f) => path.basename(f, ".md"))
    ),
    industries: new Set(
      renderable
        .filter((f) => f.replace(/\\/g, "/").startsWith("industries/"))
        .map((f) => path.basename(f, ".md"))
    ),
  };

  _cache = renderable.map((f) => parseDoc(f, ctx));
  return _cache;
}

export function getDocBySlug(slug: string): WikiDoc | undefined {
  return getAllDocs().find((d) => d.slug === slug);
}

/** Stocks sorted newest-move-first (undated fall to the bottom); industries
 * alphabetically by title. */
export function getDocsInCategory(categoryKey: string): WikiDoc[] {
  const docs = getAllDocs().filter((d) => d.dir === categoryKey);
  if (categoryKey === "stocks") {
    return docs.sort((a, b) => {
      const da = a.latestEvent?.date ?? "";
      const db = b.latestEvent?.date ?? "";
      if (da !== db) return db.localeCompare(da);
      return a.title.localeCompare(b.title, "zh");
    });
  }
  return docs.sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

export interface IndexEntry {
  date: string;
  ticker: string;
  name: string;
  summary: string;
  href: string;
}

/** Parses the hand-maintained "最新在上" bullet list out of index.md so the
 * home page can show the same chronological feed the wiki keeps by hand. */
export function getIndexEntries(): IndexEntry[] {
  const doc = getDocBySlug("index");
  if (!doc) return [];
  const out: IndexEntry[] = [];
  const re = /^- \*\*(.+?)\*\*\s*·\s*\[\[(.+?)\]\]\s*(.*?)\s*[—-]\s*(.+?)\s*→\s*\[.*?\]\((.+?)\)\s*$/;
  for (const line of doc.raw.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const href = "/" + m[5].replace(/\.md$/i, "");
    out.push({
      date: m[1].trim(),
      ticker: m[2].trim(),
      name: m[3].trim(),
      summary: m[4].trim(),
      href,
    });
  }
  return out;
}
