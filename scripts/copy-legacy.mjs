/* copy-legacy.mjs
 *
 * 当前 teachduel-web 只有首页单页，无 static legacy 内容。
 * 后续若新增 /about /privacy 等纯静态页（来源仓库根、避开 vite 产物），
 * 在此处把 public-aux/ 目录下的 html 拷进 dist/。
 *
 * M1 阶段：no-op
 */
import { existsSync } from 'node:fs';

const SRC = 'public-aux';
if (!existsSync(SRC)) {
  console.log('[copy-legacy] no public-aux/ directory, skipping');
} else {
  console.log('[copy-legacy] public-aux/ exists but copy logic not implemented yet');
}