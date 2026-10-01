/**
 * tri-sites SHARED i18n runtime  (single source of truth)
 * 位置：@tri-sites/design-system/src/i18n/runtime/i18n.js
 * 由 scripts/sync-i18n.mjs 推送到各站 public/i18n/，禁止在各站手动改副本。
 * 支持：
 * - 嵌套键查找（dot notation）
 * - 占位符替换 {name}
 * - 多个 fallback 语言
 * - localStorage 记忆 + URL 参数覆盖
 * - DOM 自动替换 [data-i18n] / [data-i18n-placeholder]
 *
 * 用法：
 *   <script src="/i18n/i18n.js"></script>
 *   <button data-i18n="common.confirm"></button>
 *   <input data-i18n-placeholder="battle.enter_name">
 *   <span data-i18n="battle.round" data-i18n-vars='{"round":1,"total":10}'></span>
 *
 *   // JS：
 *   t('common.ok')                              // "确定"
 *   t('battle.round', {round: 1, total: 10})    // "第 1/10 局"
 */
(function () {
  'use strict';

  // ─── 配置（单一真相源；站点可在 <head> 注入 window.__I18N_CONFIG__ 覆盖，无需改本文件）───
  // 示例（开启多语言时由各站自行注入，本共享文件不写死语言集）：
  //   <script>window.__I18N_CONFIG__={supported:['en','zh','ja','es','fr','de'],defaultLang:'en',dictVersion:'33'}</script>
  var CFG = (typeof window !== 'undefined' && window.__I18N_CONFIG__) || {};
  var SITE_ID = (document.documentElement.getAttribute('data-site') || 'board');
  var STORAGE_KEY = SITE_ID + 'duel_lang';   // 每站独立: boardduel_lang / mathduel_lang / memoryduel_lang
  var GENERIC_KEY = 'lang';                  // 跨站同步通用键
  // 默认仅英文（多语言关闭）。各站通过 __I18N_CONFIG__.supported 开启，不在此硬编码。
  var SUPPORTED = (Array.isArray(CFG.supported) && CFG.supported.length)
    ? CFG.supported
    : ["en"];
  var DEFAULT_LANG = CFG.defaultLang || 'en';
  var BASE_URL = CFG.baseUrl || '/i18n/';
  var DICT_VERSION = CFG.dictVersion || '27';  // 字典更新时由站点 bump（cache-buster）
  // 升级路径：构建期把字典注入 window.__I18N_DICTS__ 即可跳过网络 fetch（详见 sync 脚本说明）
  var PRELOADED = (typeof window !== 'undefined' && window.__I18N_DICTS__) || null;

  // 缓存已加载字典
  var dicts = {};
  var currentLang = null;

  /**
   * 检测初始语言（优先级：?lang > /xx/ 路径前缀 > localStorage > 默认）。
   * 所有候选都必须被 SUPPORTED 接受，否则跳过 —— 防止「路径写了 /de/ 但 de 未开启」时误切。
   */
  function detectInitialLang() {
    var candidates = [];
    // 1. URL 参数 ?lang=xx
    try {
      var fromUrl = new URLSearchParams(window.location.search).get('lang');
      if (fromUrl) candidates.push(fromUrl);
    } catch (e) {}
    // 2. URL 路径前缀 /xx/（路径优先于 localStorage，契合 SEO hreflang 声明）
    try {
      var m = window.location.pathname.match(/^\/(zh|en|ja|es|fr|de)(\/|$)/);
      if (m) candidates.push(m[1]);
    } catch (e) {}
    // 3. localStorage — 本网站点键优先, 其次跨站通用键
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) candidates.push(stored);
      var generic = localStorage.getItem(GENERIC_KEY);
      if (generic) candidates.push(generic);
    } catch (e) {}
    // 取第一个被 SUPPORTED 接受的语言
    for (var i = 0; i < candidates.length; i++) {
      if (SUPPORTED.indexOf(candidates[i]) >= 0) return candidates[i];
    }
    return DEFAULT_LANG;
  }

  /**
   * 异步加载字典（双模式）：
   *  - 优先用站点构建期注入的 window.__I18N_DICTS__[lang]（跳过网络 fetch）
   *  - 否则按 BASE_URL + lang + '?v=' + DICT_VERSION 运行时拉取
   */
  function loadDict(lang, force) {
    if (dicts[lang] && !force) return Promise.resolve(dicts[lang]);
    if (PRELOADED && PRELOADED[lang]) {
      dicts[lang] = PRELOADED[lang];
      return Promise.resolve(dicts[lang]);
    }
    return fetch(BASE_URL + lang + '.json?v=' + DICT_VERSION, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('Failed to load ' + lang);
        return r.json();
      })
      .then(function (data) {
        dicts[lang] = data;
        return data;
      });
  }

  /**
   * 按点号查找嵌套键
   * 例如：get(dict, 'common.ok') → dict.common.ok
   */
  function get(obj, path) {
    if (!obj || !path) return undefined;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /**
   * 占位符替换：把 {key} 替换为 vars[key]
   */
  function interpolate(str, vars) {
    if (!str || typeof str !== 'string') return str;
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, function (_, key) {
      return vars[key] !== undefined ? String(vars[key]) : '{' + key + '}';
    });
  }

  /**
   * 核心翻译函数
   */
  function t(key, vars, lang) {
    lang = lang || currentLang;
    var dict = dicts[lang] || {};
    var val = get(dict, key);

    // Fallback 到默认语言
    if (val === undefined && lang !== DEFAULT_LANG) {
      val = get(dicts[DEFAULT_LANG], key);
    }

    // Fallback 到 key 本身（最坏情况）
    if (val === undefined) {
      // 静默降级 — 开发时可在 console 设 window.__I18N_VERBOSE = true 重新开启
      if (typeof window !== 'undefined' && window.__I18N_VERBOSE) {
        console.warn('[i18n] missing key:', key, 'lang:', lang);
      }
      return key;
    }

    return interpolate(val, vars);
  }

  /** 解析节点上的 data-i18n-vars（JSON）——所有 i18n 分支共用 */
  function parseVars(node) {
    var varsStr = node.getAttribute('data-i18n-vars');
    if (!varsStr) return {};
    try { return JSON.parse(varsStr) || {}; } catch (e) { return {}; }
  }

  /**
   * 替换 DOM 中的 data-i18n / data-i18n-placeholder
   */
  function applyToDOM(root) {
    root = root || document;
    // data-i18n → textContent
    var nodes = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute('data-i18n');
      node.textContent = t(key, parseVars(node));
    }
    // data-i18n-placeholder → placeholder attr
    var phNodes = root.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < phNodes.length; j++) {
      var phNode = phNodes[j];
      var phKey = phNode.getAttribute('data-i18n-placeholder');
      phNode.setAttribute('placeholder', t(phKey, parseVars(phNode)));
    }
    // data-i18n-title → title attr; if it's the <title> element, also update textContent + document.title
    var ttNodes = root.querySelectorAll('[data-i18n-title]');
    for (var k = 0; k < ttNodes.length; k++) {
      var ttNode = ttNodes[k];
      var ttKey = ttNode.getAttribute('data-i18n-title');
      var ttVal = t(ttKey, parseVars(ttNode));
      ttNode.setAttribute('title', ttVal);
      if (ttNode.tagName && ttNode.tagName.toUpperCase() === 'TITLE') {
        ttNode.textContent = ttVal;
        document.title = ttVal;
      }
    }
    // data-i18n-aria-label → aria-label attr
    var alNodes = root.querySelectorAll('[data-i18n-aria-label]');
    for (var m = 0; m < alNodes.length; m++) {
      var alNode = alNodes[m];
      var alKey = alNode.getAttribute('data-i18n-aria-label');
      alNode.setAttribute('aria-label', t(alKey, parseVars(alNode)));
    }
    // data-i18n-html → innerHTML (for HTML fragments like <span style="color">...)
    var htmlNodes = root.querySelectorAll('[data-i18n-html]');
    for (var n = 0; n < htmlNodes.length; n++) {
      var htmlNode = htmlNodes[n];
      var htmlKey = htmlNode.getAttribute('data-i18n-html');
      var htmlVal = t(htmlKey, parseVars(htmlNode));
      if (htmlVal && htmlVal !== htmlKey) {
        htmlNode.innerHTML = htmlVal;
      }
    }
    // data-i18n-alt → alt attr (for images)
    var altNodes = root.querySelectorAll('[data-i18n-alt]');
    for (var a = 0; a < altNodes.length; a++) {
      var altNode = altNodes[a];
      var altKey = altNode.getAttribute('data-i18n-alt');
      altNode.setAttribute('alt', t(altKey, parseVars(altNode)));
    }
    // data-i18n-content → content attr（用于 meta[name=description] / og:title / og:description）
    var ctNodes = root.querySelectorAll('[data-i18n-content]');
    for (var c = 0; c < ctNodes.length; c++) {
      var ctNode = ctNodes[c];
      var ctKey = ctNode.getAttribute('data-i18n-content');
      ctNode.setAttribute('content', t(ctKey, parseVars(ctNode)));
    }
    // <title data-i18n="key"> → document.title
    var titleNode = root.querySelector('title[data-i18n]');
    if (titleNode) {
      var tk = titleNode.getAttribute('data-i18n');
      var tv = t(tk);
      if (tv && tv !== tk) document.title = tv;
    }
    // <meta data-i18n="key" [name|property]="..."> → content attr
    var metaNodes = root.querySelectorAll('meta[data-i18n]');
    for (var p = 0; p < metaNodes.length; p++) {
      var metaNode = metaNodes[p];
      var mk = metaNode.getAttribute('data-i18n');
      var mv = t(mk);
      if (mv && mv !== mk) metaNode.setAttribute('content', mv);
    }
    // JSON-LD 脚本中的 i18n-name / i18n-desc / i18n-lang 属性支持
    var ldNodes = root.querySelectorAll('script[type="application/ld+json"]');
    for (var q = 0; q < ldNodes.length; q++) {
      var ldNode = ldNodes[q];
      try {
        var ldData = JSON.parse(ldNode.textContent);
        var changed = false;
        var processObj = function(obj) {
          if (obj && typeof obj === 'object') {
            var i18nAttrs = ['i18n-name', 'i18n-desc', 'i18n-lang'];
            for (var ai = 0; ai < i18nAttrs.length; ai++) {
              var attr = i18nAttrs[ai];
              if (obj[attr]) {
                var key = obj[attr];
                var val = t(key);
                if (val && val !== key) {
                  if (attr === 'i18n-name') obj.name = val;
                  else if (attr === 'i18n-desc') obj.description = val;
                  else if (attr === 'i18n-lang') obj.inLanguage = val;
                  changed = true;
                }
              }
            }
            for (var k in obj) {
              if (obj.hasOwnProperty(k)) {
                processObj(obj[k]);
              }
            }
          }
        };
        processObj(ldData);
        if (changed) {
          ldNode.textContent = JSON.stringify(ldData, null, 2);
        }
      } catch (e) {}
    }
  }

  /**
   * 切换语言
   */
  function setLang(lang, options) {
    options = options || {};
    if (SUPPORTED.indexOf(lang) < 0) {
      console.warn('[i18n] unsupported lang:', lang);
      return Promise.reject(new Error('unsupported lang'));
    }
    var prevLang = currentLang;
    return loadDict(lang, true).then(function () {
      currentLang = lang;
      // P5-1: 追踪语言切换
      if (prevLang && prevLang !== lang && typeof window.plausible === 'function') {
        try { window.plausible('lang_switch', { props: { from: prevLang, to: lang } }); } catch (e) {}
      }
      // 持久化
      try { localStorage.setItem(STORAGE_KEY, lang); localStorage.setItem(GENERIC_KEY, lang); } catch (e) {}
      // 更新 <html lang="...">
      document.documentElement.setAttribute('lang', lang);
      // 更新 PWA manifest 链接（按语言）
      try {
        var manifestLink = document.querySelector('link[rel="manifest"]');
        if (manifestLink && /\/manifest\.(zh|en|ja|es|fr|de)\.webmanifest$/.test(manifestLink.getAttribute('href') || '')) {
          manifestLink.setAttribute('href', '/manifest.' + lang + '.webmanifest');
        }
      } catch (e) {}
      // 应用到 DOM
      applyToDOM();
      // 给跨站链接补 ?lang=xx，让兄弟站落地即命中该语言
      decorateCrossSiteLinks(lang);
      // 触发自定义事件（让其他模块监听语言变化）
      window.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: lang } }));
      // URL 同步（如果不是 options.skipUrl）
      if (!options.skipUrl) {
        syncUrl(lang);
      }
      return lang;
    });
  }

  /**
   * 把 lang 同步到 URL（?lang=en 或 /en/...）
   */
  function syncUrl(lang) {
    try {
      var url = new URL(window.location.href);
      // 优先用路径前缀风格
      var pathParts = url.pathname.split('/').filter(Boolean);
      var firstPart = pathParts[0];
      if (SUPPORTED.indexOf(firstPart) >= 0) {
        pathParts[0] = lang;
        url.pathname = '/' + pathParts.join('/') + (url.pathname.endsWith('/') ? '/' : '');
      } else {
        url.searchParams.set('lang', lang);
      }
      // 用 replaceState 不增加历史
      window.history.replaceState({}, '', url.toString());
    } catch (e) {}
  }

  /**
   * 跳转到带语言前缀的 URL（用于跨页面切换）
   */
  function navigateWithLang(lang, targetPath) {
    if (SUPPORTED.indexOf(lang) < 0) lang = DEFAULT_LANG;
    var path = targetPath || window.location.pathname;
    // 移除已有的语言前缀
    var parts = path.split('/').filter(Boolean);
    if (SUPPORTED.indexOf(parts[0]) >= 0) parts.shift();
    var newPath = '/' + lang + '/' + parts.join('/');
    window.location.href = newPath;
  }

  /**
   * 渲染 WS 错误消息
   * - 优先用 code 查 i18n key
   * - fallback 到 msg 字段（如果 msg 是 i18n key 形式）
   * - 再 fallback 到 msg 原字符串
   * - 最终 fallback 到 key 本身
   *
   * @param {object|string} errOrMsg - WS 错误对象 {code, msg} 或字符串 msg
   * @param {object} vars - 占位符变量
   * @returns {string} 多语言错误消息
   */
  function renderError(errOrMsg, vars) {
    vars = vars || {};
    var code = null, msg = null;
    if (typeof errOrMsg === 'string') {
      msg = errOrMsg;
    } else if (errOrMsg && typeof errOrMsg === 'object') {
      code = errOrMsg.code;
      msg = errOrMsg.msg || errOrMsg.message;
    }

    // 1. 用 code 查 i18n key 映射
    if (code) {
      var key = ERROR_CODE_MAP[code];
      if (key) {
        var translated = t(key, vars);
        if (translated && translated !== key) return translated;
      }
    }

    // 2. msg 可能是 i18n key 形式（如 "error.invalid_room_code"）
    if (msg && typeof msg === 'string' && msg.indexOf('.') > 0 && msg.indexOf(' ') < 0) {
      var v = t(msg, vars);
      if (v && v !== msg) return v;
    }

    // 3. fallback 到 msg 原字符串
    if (msg) return interpolate(msg, vars);

    // 4. 最终 fallback
    return code || t('common.error');
  }

  // 错误码 → i18n key 映射（与 ws-server/i18n/error-codes.json 同步）
  var ERROR_CODE_MAP = {
    INVALID_ROOM_CODE:        'error.invalid_room_code',
    ROOM_NOT_FOUND:           'error.room_not_found',
    ROOM_FULL:                'error.room_full',
    INVALID_PUZZLE:           'error.invalid_puzzle',
    FORMULA_INVALID:          'error.formula_invalid',
    INVALID_CELL_ID:          'error.cell_invalid',
    WRONG_ANSWER:             'error.wrong_answer',
    SUDOKU_GEN_FAILED:        'error.sudoku_generation_failed',
    KILLER_SUDOKU_GEN_FAILED: 'error.killer_sudoku_generation_failed',
    PYRAMID_GEN_FAILED:       'error.pyramid_generation_failed',
    INVALID_NAME:             'error.invalid_name',
    NAME_TOO_SHORT:           'error.name_too_short',
    NAME_TOO_LONG:            'error.name_too_long',
    RATE_LIMITED:             'error.rate_limited',
    CONNECTION_LOST:          'error.connection_lost',
    NOT_IN_ROOM:              'error.not_in_room',
    GAME_OVER:                'error.game_over',
    WRONG_TURN:               'error.wrong_turn',
    SESSION_EXPIRED:          'error.session_expired',
    SERVER_ERROR:             'error.server_error',
    INVALID_VALUE:            'error.invalid_value',
    INVALID_INDEX:            'error.invalid_index',
    CELL_INVALID:             'error.cell_invalid',
    CELL_ALREADY_FILLED:      'error.cell_already_filled',
    CELL_DUPLICATE:           'error.cell_duplicate',
    EQUATION_INVALID:         'error.equation_invalid'
  };

  // ─── 跨站语言传递 ───
  // localStorage 受同源策略限制，三站（不同域名）无法共享语言偏好。
  // 因此给「指向兄弟站的链接」补上 ?lang=xx —— 用户跳转过去时立即命中该语言。
  // 命中 ?lang 后 i18n 会把它写进 localStorage，后续该站全站跟随。
  var SIBLING_HOSTS = Array.isArray(CFG.siblingHosts)
    ? CFG.siblingHosts
    // 改名过渡期（2026-09-30 起 12 个月）：mathduel.games 与 numeriduel.com 并存
    : ['numeriduel.com', 'mathduel.games', 'boardduel.com', 'memoryduel.com'];
  function decorateCrossSiteLinks(lang) {
    try {
      if (!lang) return;
      var here = (location.hostname || '').replace(/^www\./, '');
      var links = document.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#') continue;
        var u;
        try { u = new URL(a.href, location.href); } catch (e) { continue; }
        var host = u.hostname.replace(/^www\./, '');
        if (host === here || SIBLING_HOSTS.indexOf(host) < 0) continue;
        if (u.searchParams.get('lang') === lang) continue;
        u.searchParams.set('lang', lang);
        a.setAttribute('href', u.toString());
      }
    } catch (e) {}
  }

  // ─── 暴露 API ───
  window.i18n = {
    t: t,
    setLang: setLang,
    getLang: function () { return currentLang; },
    getSupported: function () { return SUPPORTED.slice(); },
    applyToDOM: applyToDOM,
    navigateWithLang: navigateWithLang,
    decorateCrossSiteLinks: decorateCrossSiteLinks,
    loadDict: loadDict,
    renderError: renderError,
    ERROR_CODE_MAP: ERROR_CODE_MAP
  };


  // 暴露全局翻译入口，供各站点 tt()/__t()/window.t() 等调用（此前未定义导致回退中文）
  window.t = t;
  window.__t = t;

  // R-2: re-translate dynamically injected / re-rendered nodes
  var _i18nApplying = false;
  function applyI18nSafe(root) {
    _i18nApplying = true;
    try { applyToDOM(root || document); } finally { _i18nApplying = false; }
  }
  function setupI18nObserver() {
    if (typeof MutationObserver === 'undefined') return;
    var _t = null;
    var _obs = new MutationObserver(function () {
      if (_i18nApplying) return;            // ignore mutations we caused
      if (_t) clearTimeout(_t);
      _t = setTimeout(function () {
        applyI18nSafe(document); applyLiterals(document);
        try { decorateCrossSiteLinks(currentLang); } catch (e) {}
      }, 60);
    });
    _obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }


  // R-2(dynamic): 重译「组件一次性渲染、i18n 未就绪时落入中文 fallback」的文本节点
  // 组件(如 auth-modal/sidebar/coins-bar)用 __(key,'中文') 渲染, 渲染时 i18n 未就绪 -> 显示中文;
  // 此处在 i18n 就绪后 + MutationObserver 中补一遍: 命中 LITERALS 精确字面量即译为对应 key。
var LITERALS = {"玩家": "account.default_player", "昵称必须是字符串": "account.nickname_must_be_string", "昵称至少 ": "account.nickname_too_short", "昵称最多 ": "account.nickname_too_long", "昵称包含敏感词,请换个名字": "account.nickname_profanity", "JSON 格式错误: ": "account.json_format_error", "缺少 history 数组": "account.missing_history", "缺少 nickname": "account.missing_nickname", "免广告已激活，剩余": "coins.ad_free_active", "天": "common.days", "当前积分": "coins.current_balance", "可兑换": "coins.can_exchange", "差": "coins.deficit", "积分": "coins.points", "邀请1位好友立得500积分，更划算！": "coins.invite_bonus", "立即邀请": "coins.invite_now", "处理中...": "common.processing", "兑换成功！": "coins.exchange_success", "免广告剩余": "coins.ad_free_remaining", "剩余积分：": "coins.remaining_balance", "知道了！": "common.got_it", "积分不足": "coins.insufficient_balance", "兑换失败": "coins.exchange_failed", "网络错误，请重试！": "common.network_error", "登录后查看积分": "coins.login_to_view", "赚更多积分": "coins.earn_more", "处理中…": "auth.processing", "注册并领取 100 积分": "auth.register_btn", "请填写所有字段": "auth_error.fill_all_fields", "请输入有效邮箱": "auth_error.invalid_email", "密码至少8位": "auth_error.password_too_short", "注册成功！请查收验证邮件": "auth.verification_sent", "📧 已发送验证邮件，请查收并点击邮件中的链接完成激活。": "auth.verifying_email", "该邮箱已注册，请登录": "auth_error.email_already_registered", "当前 IP 注册次数已达上限，请稍后再试": "auth_error.ip_register_limit", "人机验证失败，请刷新页面重试": "auth_error.turnstile_failed", "密码需包含大写字母": "auth_error.password_need_uppercase", "请求过大": "auth_error.body_too_large", "注册失败": "auth_error.register_failed", "网络错误，请重试": "auth_error.network_error_retry", "请填写邮箱和密码": "auth_error.fill_email_password", "邮箱或密码错误": "auth_error.invalid_credentials", "邮箱未激活，请先验证邮箱": "auth_error.email_not_verified", "登录失败": "auth_error.login_failed", "如果该邮箱已注册，我们已发送重置链接。": "auth.forgot_success", "绑定失败": "auth_error.bind_failed", "缺少重置令牌": "auth_error.missing_reset_token", "两次密码不一致": "auth_error.password_mismatch", "✅ 密码已重置，即将跳转登录…": "auth.reset_success", "重置链接无效或已过期，请重新申请": "auth.reset_link_invalid", "重置失败": "auth_error.reset_failed", "关闭": "auth.close_btn", "欢迎加入": "auth.welcome", "注册即送100积分，玩游戏攒积分换免广告": "auth.register_bonus", "注册": "nav.register", "登录": "auth.login_btn", "邮箱": "auth.email_label", "密码（8位含大小写+数字）": "auth.password_label", "昵称（2-20字符）": "auth.nickname_label", "你的昵称": "auth.nickname_placeholder", "或使用第三方账号": "auth.or_third_party", "使用 Google 注册": "auth.google_register", "使用 GitHub 注册": "auth.github_register", "注册即表示同意我们的服务条款和隐私政策": "auth.agree_terms", "已有账号？": "auth.already_have_account", "立即登录": "auth.login_now", "密码": "auth.password_placeholder_short", "使用 Google 登录": "auth.google_login", "使用 GitHub 登录": "auth.github_login", "忘记密码？": "auth.forgot_password", "没有账号？": "auth.no_account", "立即注册": "auth.register_now", "输入注册邮箱，我们会发送密码重置链接。": "auth.forgot_intro", "注册邮箱": "auth.forgot_email_label", "发送重置链接": "auth.send_reset_link", "想起密码了？登录": "auth.remember_password", "请输入新密码完成重置。": "auth.reset_intro", "新密码（至少8位）": "auth.new_password_label", "确认新密码": "auth.confirm_password_label", "再次输入": "auth.confirm_password_placeholder", "设置新密码": "auth.set_new_password", "返回登录": "auth.back_to_login", "未入榜": "leaderboard.unranked", "首页": "nav.home", "关于": "nav.about", "联系": "nav.contact", "隐私": "nav.privacy", "条款": "nav.terms", "24 点": "games.24", "24 点初级": "games.24easy", "数独": "games.sudoku", "6格数独": "games.sudoku6", "杀手数独": "games.killer", "金字塔": "games.pyramid", "数学对决 Duel": "site.name_math", "棋盘对决 Duel": "site.name_board", "知识对决 Duel": "site.name_memory", "NumeriDuel · 数学对决": "brand.math_line", "BoardDuel · 棋盘对决": "brand.board_line", "MemoryDuel · 知识对战": "brand.memory_line", "© 2026 数学对决 · 纯静态 · 无追踪 · 无广告": "footer.copy_math", "纯静态 · 无追踪 · 无广告": "footer.tagline_math", "探索更多": "brand.explore_more", "单人自玩": "two048.solo", "🎯 目标 2048": "two048.goal", "用方向键 / 按钮滑动合并": "two048.hint", "新对局开始（进阶 · 挖空 30 格）": "archive.newgame", "📖 玩法": "puzzle.howto", "数字华容道玩法": "puzzle.title", "滑动数字": "puzzle.slide", "让所有数字按 1, 2, 3... 顺序排列": "puzzle.order", "步数越少越好": "puzzle.fewer", "尝试用最少的步数完成挑战": "puzzle.try", "下一步": "puzzle.next", "跳过": "puzzle.skip", "配对 easy": "train.pair_easy", "配对 medium": "train.pair_medium", "配对 hard": "train.pair_hard", "数字 easy": "train.num_easy", "数字 medium": "train.num_medium", "数字 hard": "train.num_hard", "404 - 页面未找到 · Memory Duel": "title.memory_404", "会员中心 · MemoryDuel": "title.memory_membership", "关于 · MemoryDuel 知识对战": "title.memory_about", "联系我们 · MemoryDuel": "title.memory_contact", "井字棋 - 在线对战 | Board Duel": "title.game_ttt", "五子棋 - 在线对战 | Board Duel": "title.game_gomoku", "黑白棋 - 在线对战 | Board Duel": "title.game_othello", "国际象棋 - 在线对战 | Board Duel": "title.game_chess", "西洋跳棋 - 在线对战 | Board Duel": "title.game_checkers", "四子棋 - 在线对战 | Board Duel": "title.game_connect4", "MemoryDuel · 单人训练": "title.memory_train", "你": "player.you", "白方": "player.white", "白方走": "player.white_turn", "势均力敌": "game.even", "对局开始": "game.started", "人机对弈 · 难度: 普通 · 你先猜": "bulls.ai_status_you", "人机对弈 · 难度: 普通": "bulls.ai_status", "中等 · 2 层搜索 + 子力/位置评估": "checkers.ai_level", "● 你 (你)": "ml15.you", "● 电脑 AI": "ml15.cpu", "🆕 新对局开始，你执 ⚫ 先行。": "coach.new_black", "🆕 新对局开始，你执 ✕ 先行。": "coach.new_x", "🆕 新对局开始，你执 🔴 先行。": "coach.new_red", "🆕 新对局开始，执白先走。": "coach.new_white", "余额 0": "shop.balance_zero", "狐狸": "shop.fox", "熊猫": "shop.panda", "狮子": "shop.lion", "章鱼": "shop.octopus", "火焰": "shop.flame", "宝石": "shop.gem", "王冠": "shop.crown", "星光": "shop.starlight", "1.5× 积分": "shop.x15", "2× 积分": "shop.x2", "完成对局后即可上榜": "rank.unranked_hint", "点击 3 个格子，按顺序组成算式": "pyramid.hint", "📖 数字华容道玩法": "puzzle.title2", "点击与空格相邻的数字，让它滑入空位。": "puzzle.slide2", "恢复顺序": "puzzle.restore", "让所有数字按 1, 2, 3... 顺序排列。": "puzzle.order2", "尝试用最少的步数完成挑战。": "puzzle.try2", "新游戏开始（进阶 · 挖空 30 格）": "archive.newgame2"};

  function applyLiterals(root) {
    if (!LITERALS || !window.i18n) return;
    root = root || document;
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'NOSCRIPT') continue;
      if (!el.children.length) {
        // 叶子节点：整段文本精确命中 LITERALS
        var txt = (el.textContent || '').trim();
        if (!txt) continue;
        var key = LITERALS[txt];
        if (!key) continue;
        var tv = window.i18n.t(key);
        if (tv && tv !== key && tv !== txt) el.textContent = tv;
        continue;
      }
      // 非叶子节点（如含 <svg> 图标的 oauth 按钮、混合文本节点 "已有账号？<button>"）：
      // 逐直接文本子节点匹配 LITERALS，命中即重写该文本节点。
      var nodes = el.childNodes;
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.nodeType !== 3) continue;
        var nt = (n.nodeValue || '').trim();
        if (!nt) continue;
        var k = LITERALS[nt];
        if (!k) continue;
        var tval = window.i18n.t(k);
        if (tval && tval !== k && tval !== nt) n.nodeValue = tval;
      }
    }
  }

  // ─── 启动：检测 + 加载 + 应用 ───
  var initLang = detectInitialLang();
  loadDict(initLang, true).then(function () {
    currentLang = initLang;
    document.documentElement.setAttribute('lang', initLang);
    // URL 显性指定语言（?lang=xx 或 /xx/ 路径前缀，典型场景：兄弟站 / 分享链接接力）时
    // 也要持久化 —— 否则用户点进下一个不带 ?lang 的页面会掉回默认语言。
    try {
      var _q = new URLSearchParams(window.location.search).get('lang');
      var _pm = (window.location.pathname || '').match(/^\/(zh|en|ja|es|fr|de)(\/|$)/);
      if ((_q || _pm) && SUPPORTED.indexOf(initLang) >= 0) {
        localStorage.setItem(STORAGE_KEY, initLang);
        localStorage.setItem(GENERIC_KEY, initLang);
      }
    } catch (e) {}
    // 等 DOMContentLoaded 再 apply
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyToDOM(); });
      setupI18nObserver();
    } else {
      applyToDOM();
    }
    applyLiterals();
    // 首屏就绪后也装饰一次（未切换过语言也要带上当前语言）
    decorateCrossSiteLinks(initLang);
    // 标记就绪
    document.documentElement.setAttribute('data-i18n-ready', 'true');
    setupI18nObserver();
    window.dispatchEvent(new CustomEvent('i18n:ready', { detail: { lang: initLang } }));
  }).catch(function (err) {
    console.error('[i18n] init failed:', err);
    document.documentElement.setAttribute('data-i18n-ready', 'error');
  });
})();
