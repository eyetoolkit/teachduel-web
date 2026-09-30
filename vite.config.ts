import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 发布阶段过滤：data-stage="beta" 的元素在生产构建中自动剔除
 * （与 memoryduel-web 同构；teachduel 起步只有 live，先把机制备好）
 */
function filterStage() {
  return {
    name: 'filter-stage',
    transformIndexHtml: {
      order: 'pre' as const,
      handler(html: string) {
        if (process.env.VITE_SHOW_BETA === '1') return html;
        return html.replace(/<a\b[^>]*\bdata-stage="beta"[^>]*>[\s\S]*?<\/a>\s*/g, '');
      },
    },
  };
}

/** 清理 index.html 里用于构建标记的环境变量占位符 */
function stripEnvPlaceholders() {
  return {
    name: 'strip-env-placeholders',
    transformIndexHtml(html: string) {
      return html.replace(/%VITE_[A-Z0-9_]+%/g, '');
    },
  };
}

export default defineConfig({
  plugins: [filterStage(), stripEnvPlaceholders()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});