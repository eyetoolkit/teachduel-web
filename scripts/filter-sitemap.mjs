/* filter-sitemap.mjs
 *
 * 当前 teachduel-web 没有 sitemap.xml（只有首页单页，不需要 sitemap）。
 * 后续如果游戏增多、多页出现，需要 sitemap 时在此实现过滤逻辑。
 *
 * 参考 memoryduel/boardduel 的教训：sitemap 过滤脚本的 live 正则必须
 * 接受所有 live 路径，否则生产 sitemap 被清空 → 搜索引擎收不到页面。
 *
 * M1 阶段：no-op
 */
import { existsSync } from 'node:fs';

const SRC = 'dist/sitemap.xml';
if (!existsSync(SRC)) {
  console.log('[filter-sitemap] no dist/sitemap.xml, skipping');
} else {
  console.log('[filter-sitemap] dist/sitemap.xml exists but filter logic not implemented yet');
}