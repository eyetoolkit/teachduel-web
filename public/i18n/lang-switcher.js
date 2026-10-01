/* ═══════════════════════════════════════════════════════════════
   lang-switcher.js — 语言切换器（注入 + 行为）v2
   用法（支持多挂载）：
     <div id="lang-switcher"></div>          ← 放在导航/顶栏内（内嵌模式）
     <div data-lang-switcher></div>          ← 第二个挂载（如同id，侧栏等）
     <script src="/i18n/lang-switcher.js?v=35" defer></script>

   模式自适应：
     - 挂载点位于 nav/header/.topbar/.sidebar 内 → 内嵌图标按钮（38px，菜单向下）
     - 其它位置（如 body 末尾）→ 右下角浮动圆球（46px，菜单向上）
   样式使用命名空间 --lsw-* 变量，不依赖站点语义变量（各站 --ink/--paper 含义相反）。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ALL_LANGS = [
    { code: 'zh', label: '中文', flag: '🇨🇳' },
    { code: 'en', label: 'English', flag: '🇺🇸' },
    { code: 'es', label: 'Español', flag: '🇪🇸' },
    { code: 'fr', label: 'Français', flag: '🇫🇷' },
    { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
    { code: 'ja', label: '日本語', flag: '🇯🇵' },
  ];
  // 仅渲染运行时实际支持的语言（多语言关闭时只显示 en），避免列出不可点的语言
  function getSupportedLangs() {
    try {
      if (window.i18n && typeof window.i18n.getSupported === 'function') {
        var s = window.i18n.getSupported();
        if (s && s.length) {
          var filtered = ALL_LANGS.filter(function (l) { return s.indexOf(l.code) >= 0; });
          if (filtered.length) return filtered;
        }
      }
    } catch (e) {}
    return ALL_LANGS; // 回退：全列
  }
  var LABELS = {};
  ALL_LANGS.forEach(function (l) { LABELS[l.code] = l.label; });

  var GLOBE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="9"/>'
    + '<path d="M3 12h18M12 3a15.5 15.5 0 0 1 0 18M12 3a15.5 15.5 0 0 0 0 18"/>'
    + '</svg>';

  var CSS = ''
    + '.lang-switcher{position:relative;display:inline-flex;flex:none;font-family:inherit}'
    + '.lang-switcher .lsw-btn{width:38px;height:38px;padding:0;display:grid;place-items:center;'
    +   'background:var(--lsw-bg,#fff);border:1px solid var(--lsw-line,rgba(25,20,45,.16));'
    +   'border-radius:10px;color:var(--lsw-fg,#3b3552);cursor:pointer;'
    +   'transition:border-color .15s,color .15s,box-shadow .15s;font:inherit}'
    + '.lang-switcher .lsw-btn:hover{border-color:var(--lsw-fg,#3b3552);color:var(--lsw-fg,#3b3552)}'
    + '.lang-switcher .lsw-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;'
    +   'stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}'
    + '.lang-switcher .lsw-menu{position:absolute;top:calc(100% + 8px);right:0;min-width:184px;'
    +   'max-width:calc(100vw - 24px);margin:0;padding:6px;list-style:none;'
    +   'background:var(--lsw-bg,#fff);border:1px solid var(--lsw-line,rgba(25,20,45,.16));'
    +   'border-radius:14px;box-shadow:0 14px 36px var(--lsw-shadow,rgba(25,20,45,.18));'
    +   'display:none;z-index:9600}'
    + '.lang-switcher.open .lsw-menu{display:block}'
    + '.lang-switcher .lsw-opt{display:flex;align-items:center;gap:10px;width:100%;'
    +   'padding:9px 11px;border:0;border-radius:9px;background:none;font:inherit;'
    +   'font-size:.88rem;color:var(--lsw-fg,#3b3552);cursor:pointer;text-align:left}'
    + '.lang-switcher .lsw-opt:hover{background:var(--lsw-hover,rgba(25,20,45,.06))}'
    + '.lang-switcher .lsw-flag{font-size:1rem;line-height:1}'
    + '.lang-switcher .lsw-check{margin-left:auto;font-weight:800;opacity:0;transition:opacity .1s}'
    + '.lang-switcher .lsw-opt[aria-selected="true"]{font-weight:700}'
    + '.lang-switcher .lsw-opt[aria-selected="true"] .lsw-check{opacity:1}'
    /* 浮动模式（挂载点不在导航内时）：右下角圆球，菜单向上 */
    + '.lang-switcher--float{position:fixed;bottom:18px;right:18px;z-index:9500}'
    + '.lang-switcher--float .lsw-btn{width:46px;height:46px;border-radius:50%;'
    +   'box-shadow:0 6px 20px rgba(25,20,45,.22)}'
    + '.lang-switcher--float .lsw-menu{top:auto;bottom:calc(100% + 10px)}'
    /* 暗色（boardduel 等站 html[data-theme=dark]） */
    + 'html[data-theme="dark"] .lang-switcher{--lsw-bg:#20233a;--lsw-fg:#e8e9f3;'
    +   '--lsw-line:rgba(255,255,255,.16);--lsw-hover:rgba(255,255,255,.08);'
    +   '--lsw-shadow:0 14px 36px rgba(0,0,0,.55)}';

  function injectCSS() {
    if (document.getElementById('lang-switcher-style')) return;
    var style = document.createElement('style');
    style.id = 'lang-switcher-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function currentLang() {
    return (window.i18n && window.i18n.getLang && window.i18n.getLang()) || 'en';
  }

  function buildHost(host) {
    if (host.getAttribute('data-lsw-ready') === '1') return; // 幂等
    host.classList.add('lang-switcher');
    // 内嵌 vs 浮动：挂在导航内 → 内嵌；否则 → 浮动圆球
    var inNav = host.closest('nav,header,.topbar,.nav-in,.nav-inner,.sidebar,.site-header');
    if (!inNav) host.classList.add('lang-switcher--float');

    var items = '';
    getSupportedLangs().forEach(function (l) {
      items += '<li role="none"><button type="button" class="lsw-opt" role="option"'
        + ' data-lang="' + l.code + '" aria-selected="false">'
        + '<span class="lsw-flag" aria-hidden="true">' + l.flag + '</span>'
        + '<span class="lsw-name">' + l.label + '</span>'
        + '<span class="lsw-check" aria-hidden="true">✓</span>'
        + '</button></li>';
    });
    host.innerHTML = ''
      + '<button type="button" class="lsw-btn" aria-haspopup="listbox"'
      +   ' aria-expanded="false" aria-label="Switch language">'
      +   GLOBE_SVG
      + '</button>'
      + '<ul class="lsw-menu" role="listbox" aria-label="Language">'
      +   items
      + '</ul>';
    host.setAttribute('data-lsw-ready', '1');

    var btn = host.querySelector('.lsw-btn');
    var menu = host.querySelector('.lsw-menu');

    function close() {
      host.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = !host.classList.contains('open');
      // 关闭其它实例，保证同屏只开一个菜单
      document.querySelectorAll('.lang-switcher.open').forEach(function (o) {
        if (o !== host) {
          o.classList.remove('open');
          var b = o.querySelector('.lsw-btn');
          if (b) b.setAttribute('aria-expanded', 'false');
        }
      });
      host.classList.toggle('open', willOpen);
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    host.querySelectorAll('.lsw-opt').forEach(function (opt) {
      opt.addEventListener('click', function (e) {
        e.preventDefault();
        var lang = opt.getAttribute('data-lang');
        if (window.i18n && window.i18n.setLang) {
          window.i18n.setLang(lang).then(function () {
            updateAll();
            close();
            window.dispatchEvent(new CustomEvent('language-changed', { detail: { lang: lang } }));
          });
        }
      });
    });
    host._lswClose = close;
  }

  function updateAll() {
    var lang = currentLang();
    document.querySelectorAll('.lang-switcher').forEach(function (host) {
      var btn = host.querySelector('.lsw-btn');
      if (btn) {
        btn.setAttribute('title', LABELS[lang] || lang);
        btn.setAttribute('aria-label', 'Switch language (current: ' + (LABELS[lang] || lang) + ')');
      }
      host.querySelectorAll('.lsw-opt').forEach(function (opt) {
        var isCur = opt.getAttribute('data-lang') === lang;
        opt.setAttribute('aria-selected', isCur ? 'true' : 'false');
      });
    });
  }

  // 全局事件（点击外部关闭 / Esc 关闭 / 语言变更刷新选中态）只绑定一次
  var _lswWired = false;
  function wireGlobalOnce() {
    if (_lswWired) return;
    _lswWired = true;
    document.addEventListener('click', function () {
      document.querySelectorAll('.lang-switcher.open').forEach(function (o) {
        o.classList.remove('open');
        var b = o.querySelector('.lsw-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.lang-switcher.open').forEach(function (o) {
          if (o._lswClose) o._lswClose();
        });
      }
    });
    window.addEventListener('i18n:ready', updateAll);
    window.addEventListener('i18n:change', updateAll);
  }

  /** 幂等挂载：为所有尚未初始化的 host 建 DOM，返回 host 总数 */
  function mountAll() {
    var hosts = document.querySelectorAll('#lang-switcher, [data-lang-switcher]');
    var mounted = 0;
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (h._lswBuilt) continue;
      h._lswBuilt = true;
      buildHost(h);
      mounted++;
    }
    wireGlobalOnce();
    if (mounted) updateAll();
    return hosts.length;
  }

  function init() {
    injectCSS();
    if (mountAll() > 0) return;
    // 挂载点由 JS 后置渲染（如 mathduel 首页 chrome）：轮询等它出现
    if (typeof MutationObserver === 'undefined') return;
    var _t = null;
    var _obs = new MutationObserver(function () {
      if (_t) clearTimeout(_t);
      _t = setTimeout(function () {
        if (mountAll() > 0) { _obs.disconnect(); }
      }, 60);
    });
    _obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
