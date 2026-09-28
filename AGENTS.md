## What this is

Display site for the **stock-why-wiki** content repo
(github.com/BelindaSun/stock-why-wiki). Content lives there as plain Markdown
(no front matter); this project clones it at build time and renders it. Do not
add build-related files to the content repo.

## Development

```
npm install
npm run dev        # fetches content, then starts astro dev
```

`npm run dev` and `npm run build` both run `scripts/fetch-content.mjs` first,
which clones/pulls the content repo into `.content-cache/` (gitignored) and
mirrors the interactive graphs into `public/graph/` (`index.html`, `graph.html`,
`graph-biotech.html` → `biotech.html`, `graph-china.html` → `china.html`, plus
`i18n.js` / `i18n-en.json`).

## How content is parsed (src/lib/content.ts)

- Title = first `# ` heading.
- Meta line under the title: `_Asset type: …_ · _Last updated: …_` (stocks) or
  `_Last updated: …_ · _趋势：…_` (industries).
- Latest move = first `## YYYY-MM-DD — …` timeline heading.
- Wiki cross-links `[[TICKER]]` / `[[industry:slug]]` become site links when the
  target file exists, plain text otherwise.
- Only `stocks/*.md`, `industries/*.md`, `index.md`, `overview.md`,
  `healthcare-overview.md`, and `china-overview.md` become pages. A new root
  overview needs three edits: `ROOT_PAGES`, the nav in `Base.astro`, and a
  home card in `index.astro`.
- Stock file names may contain dots (Yahoo tickers such as `688256.SS`,
  `0700.HK`); these build and serve as normal routes.

No front matter or markers are needed in the content repo — everything is
inferred from content and path.

## Deploy

Vercel, build command `npm run build`, output `dist/`. See README for the
auto-rebuild Deploy Hook wiring.
