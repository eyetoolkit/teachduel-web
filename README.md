# TeachDuel

> Free classroom games for teachers. Turn BoardDuel (strategy), NumeriDuel (logic),
> MemoryDuel (knowledge battle) into your classroom toolkit.
> No signup. No student identity data. 30 seconds to start.

## Stack

- Vite 5 SPA
- TypeScript (strict, `tsc --noEmit` runs as part of build — type errors silently keep old version)
- pnpm
- Cloudflare Pages (main → production, beta → preview)

## Local development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

## Production build

```bash
pnpm build          # → dist/, contains only live features
pnpm build:beta     # → dist/, contains beta features for preview deploy
```

## Project layout

```
.
├── index.html              Home page
├── src/
│   ├── home.ts             Home page interactions (room code input)
│   └── home.css            Home page styles (uses tokens-teach.css variables)
├── public/
│   ├── 404.html            Cloudflare Pages fallback — DO NOT delete
│   ├── _headers            Cloudflare Pages security & cache headers
│   ├── favicon.svg         TeachDuel brand icon
│   └── tokens-teach.css    html[data-site="teach"] brand tokens
├── scripts/
│   ├── copy-legacy.mjs     (added later for static page reuse)
│   └── filter-sitemap.mjs  (added later for sitemap production filtering)
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Brand

- Primary color: Teal `#0F766E` (`--brand-700`)
- Teal-600 (`#0D9488`) is NOT used as `--brand` because its white-text contrast is only 3.7:1 (fails WCAG AA).
- See `public/tokens-teach.css` for the full 9-step ramp.