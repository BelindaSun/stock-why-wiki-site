# Stock Why Wiki Site

`stock-why-wiki`（[github.com/BelindaSun/stock-why-wiki](https://github.com/BelindaSun/stock-why-wiki)）的展示网站。这是一个**独立的**项目——内容仓库本身保持纯 Markdown、没有 front matter、没有任何建站相关的东西，这个网站只是在构建时把内容拉过来渲染成好看的页面。

> 内容仓库由 Claude 的 `stock-why` skill 自动维护（每问一只票就新增/追加一份档案并 push）。本站与它零耦合：只读、只在构建时拉取。

## 怎么工作的

1. `npm run build`（或 `npm run dev`）先跑 `scripts/fetch-content.mjs`，把内容仓库浅克隆到本地 `.content-cache/`（gitignore，不提交），并把自包含的交互式关系图（`index.html`）镜像到 `public/graph/`
2. `src/lib/content.ts` 读取 `.content-cache` 里的 Markdown：
   - **标题** = 文件第一个 `# ` 标题
   - **元信息** = 标题下那行 `_Asset type: …_ · _Last updated: …_`（个股）或 `_Last updated: …_ · _趋势：…_`（行业）
   - **最新异动** = 时间线里第一个 `## YYYY-MM-DD — …` 小标题
   - **互链** `[[TICKER]]` / `[[industry:slug]]` 会在目标文件存在时改写成站内链接，否则显示为纯文字（不会 404）
   - 只有 `stocks/*.md`、`industries/*.md`、`index.md`、`overview.md` 会变成页面
3. Astro 用 `src/layouts/Article.astro` 统一套样式渲染

**不需要给内容仓库加任何 front matter 或标记**——所有信息都从文件内容和路径自动推断。

## 页面

- `/` 首页：从 `index.md` 解析出的"最新条目"时间线
- `/stocks/` 个股列表 · `/stocks/<TICKER>` 单只档案
- `/industries/` 行业列表 · `/industries/<slug>` 单个主题
- `/overview` 产业链导览 · `/graph/` 交互式关系图 · `/index` 全部条目

## 本地开发

```bash
npm install
npm run dev
```

## 构建 / 部署前检查

```bash
npm run build           # 会自动重新拉取最新内容再构建
npm run check-links     # 检查站内死链接
```

## 部署

部署在 Vercel，构建命令 `npm run build`，输出目录 `dist/`。

**关键**：网站只在自己被重新构建时才拉取内容仓库的最新内容。光往 `stock-why-wiki` 仓库 push 新条目，网站不会自动更新——需要触发一次 Vercel 重新构建。做法：Vercel 配一个 **Deploy Hook**，`stock-why-wiki` 仓库加一个 GitHub Action，每次 push 到 `main` 就 curl 一下这个 hook。

### 自动更新（Deploy Hook）

1. Vercel 项目 → Settings → Git → Deploy Hooks，新建一个（名字随意，比如 `content-update`），分支填 `main`，生成一个 URL
2. 把 [`deploy/notify-site.yml`](deploy/notify-site.yml) 复制到**内容仓库** `stock-why-wiki` 的 `.github/workflows/notify-site.yml`
3. 把第 1 步的 URL 存进 `stock-why-wiki` 仓库的 Settings → Secrets and variables → Actions，命名为 `SITE_DEPLOY_HOOK`

这样以后每次 `stock-why` skill 往内容仓库 push 新条目，网站会在几分钟内自动重新构建、更新——包括镜像进来的交互式关系图。
