/* TeachDuel 首页交互
 *
 * 核心动作：学生输入房间码 → 识别所属站 → 跳转到对应站点的游戏入口。
 *
 * 房间码如何识别站点？
 *   方案 A（采用）：教师端 `/api/teacher/assignments` 接口已记录 `site` 字段，
 *     实际查询复杂度高不适合前端做。
 *   方案 B：直接试每个站的 invite 端点直到 200 —— 增加额外网络延迟。
 *   方案 C（最简）：让用户从三站卡片点开，每个卡片聚焦一种房码风格。
 *     但首页学生是从老师发的链接进来，多数已带完整域名。
 *
 * 决定：首页房间码输入框作为辅助入口，主要走教师链接路径。
 *       房间码解析需要后端做 lookup（M1 阶段后端还没起，先做幂等 UI）。
 *
 * ⭐ 必须 import './home.css'：
 *    vite 在 src/ 里只编译被 main.ts / index.html 引用的模块。
 *    home.css 通过 home.ts 的 import 才能被打包到 dist/assets/main-*.css。
 *    否则 index.html 里的 <link href=/assets/main-*.css> 会指向 stale 文件，
 *    浏览器拿到的是 404 HTML 样式，整个页面无样式（v3 2026-10-01 实测）。
 */
import './home.css';

const form = document.getElementById('codeForm') as HTMLFormElement | null;
const input = document.getElementById('codeInput') as HTMLInputElement | null;
const hint = document.getElementById('codeHint') as HTMLParagraphElement | null;

if (form && input && hint) {
  // 自动转大写
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) {
      hint.textContent = '请输入房间码';
      hint.className = 'code-hint error';
      hint.hidden = false;
      return;
    }

    // M1 阶段：还不知道站归属，提示用户从三站卡片进入（如果老师发了完整链接）
    // 后续接入 `/api/teacher/lookup?code=XXX` 后再改成自动跳转
    hint.textContent = `房间码 ${code} 已记录。M1 阶段需要从教师发的完整链接进入，或从上方选择站点。`;
    hint.className = 'code-hint ok';
    hint.hidden = false;

    // 兜底：把码存到 sessionStorage，console 页可读出来再帮用户定位
    try {
      sessionStorage.setItem('td_last_code', code);
    } catch {}
  });
}

// 控制台页 URL 参数预填（点击三站卡片时带入 ?site=xxx）
document.querySelectorAll<HTMLAnchorElement>('[data-site-link]').forEach((a) => {
  a.addEventListener('click', () => {
    const site = a.dataset.siteLink;
    if (site) {
      try { sessionStorage.setItem('td_target_site', site); } catch {}
    }
  });
});
