'use strict';
/* ═══════════════════════════════════════════════════════════════
   TeachDuel · Teacher dashboard — logic (Worker API edition)
   ────────────────────────────────────────────────────────────────
   与设计包原实现的两处决定性差异：
     1. 认证：复用站点已有的邮箱+密码 auth（POST /api/auth/login），
        不再引入 Supabase magic-link —— 老师账号与游戏账号是同一套，
        且不需要第二套后端。
     2. 数据：全部走 Worker 服务端通道 /api/teacher/*。房间码由服务端
        注册后下发（原设计的本地随机码会让扫码的学生必然 404），
        作答回写也经服务端，任何写库密钥都不会出现在浏览器里。
   合规：FERPA-light —— 学生侧只有代号，界面与存储都不接触真实姓名。
   ═══════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const API = '/api';
const TS_SITEKEY = '0x4AAAAAAE9UnLMYQbPPsK5Q';   // 与主站 auth-modal 同 key
/* i18n：运行时就绪前回退英文兜底文案；切换语言后由 i18n:change 重绘 */
const T = (k, d, v) => { try { const r = window.t ? window.t(k, v) : null; return r && r !== k ? r : d; } catch (e) { return d; } };

let classes = [];
let current = null;
let roster = [];
let assignment = null;
const trendCache = {};            // classId → /trend 响应（M2 跨作业趋势）
let report = null;
let games = [];
let assignmentList = [];
let liveTimer = null;

/* ─── 浏览器本地教师身份（免登陆模式下每个浏览器一个独立课堂空间） ───
   2026-10-06：服务端已取消「缺头回退到共享身份」，缺身份一律 401。
   所以这里**必须保证永远返回一个合法 id**——返回空串等于让用户直接撞 401。
   三级降级：localStorage → sessionStorage → 内存（仅本页有效）。
   之所以以前能返回 '' 还"没事"，是因为服务端把所有缺头的请求都收进了
   同一个共享桶——那不是兜底，那是所有人的数据混在一个命名空间里。 */
let _anonMemory = null;
function anonId() {
  try {
    const existing = localStorage.getItem('md_teacher_anon');
    if (existing && existing.startsWith('a-')) return existing;
  } catch (e) { /* localStorage 被禁（隐私模式 / 站点数据禁用），往下走 */ }
  const fresh = 'a-' + ((crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
  try { localStorage.setItem('md_teacher_anon', fresh); return fresh; } catch (e) { /* 继续 */ }
  try {
    const s = sessionStorage.getItem('md_teacher_anon');
    if (s && s.startsWith('a-')) return s;
    sessionStorage.setItem('md_teacher_anon', fresh);
  } catch (e) { /* 继续 */ }
  if (!_anonMemory) _anonMemory = fresh;   // 关掉所有存储时的最后一级：本页内稳定
  return _anonMemory;
}

/* ─── API ─── */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Anon-Teacher': anonId(), ...(opts.headers || {}) },
  });
  if (res.status === 401) { showAuth(); throw new Error('auth_required'); }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error) || res.statusText || 'request_failed');
  return data;
}

/* ─── auth（复用站点现有账号体系：login + register） ─── */
let tsToken = 'skip';
let tsWidget = null;
function renderTurnstile() {
  try {
    if (!window.turnstile || tsWidget !== null) return tsWidget !== null;
    tsWidget = window.turnstile.render('#turnstile-container', {
      sitekey: TS_SITEKEY,
      theme: 'light',
      callback: (t) => { tsToken = t; },
      'error-callback': () => { tsToken = 'error'; },
      'expired-callback': () => { tsToken = 'expired'; },
    });
    return true;
  } catch (e) { return false; }
}
function waitTurnstile() {
  if (renderTurnstile()) return;
  let n = 0;
  const iv = setInterval(() => {
    n++;
    if (renderTurnstile() || n > 40) clearInterval(iv);
  }, 200);
}
/* token 是一次性的：每次提交（无论成败）后必须 reset 出新 token，
   否则下一次提交永远 turnstile_failed。此前用重复 render，容器已占用会静默失败。 */
function resetTurnstile() {
  tsToken = 'skip';
  try {
    if (window.turnstile && tsWidget !== null) window.turnstile.reset(tsWidget);
    else { tsWidget = null; waitTurnstile(); }
  } catch (e) { tsWidget = null; waitTurnstile(); }
}

function showAuth(msg) {
  $('auth').classList.add('on');
  if (msg) $('authErr').textContent = msg;
}
function hideAuth() { $('auth').classList.remove('on'); $('authErr').textContent = ''; }

/* 免登陆共享模式：后端用固定共享身份返回 anonymous=true。
   此时隐藏登录/登出 UI，避免误触弹窗、也不会有可退出的会话。 */
function enterAnonMode() {
  try { hideAuth(); } catch (e) {}
  try { $('auth').style.display = 'none'; } catch (e) {}
  try { $('logoutBtn').style.display = 'none'; } catch (e) {}
  const who = $('who');
  if (who) who.textContent = T('tn.anon_demo', '👋 Demo · no sign-in');
}

/* ─── login / signup 双模式 ─── */
let authMode = 'login';
const HINTS = () => ({
  login: T('tn.hint_login', 'Sign in with your TeachDuel account to open your classes.'),
  signup: T('tn.hint_signup', 'Create a free account — teachers and players share the same account system. We\u2019ll email you a verification link.'),
});
function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('on', mode === 'login');
  $('tabSignup').classList.toggle('on', mode === 'signup');
  $('authName').style.display = mode === 'signup' ? '' : 'none';
  $('authHint').textContent = HINTS()[mode];
  $('authSend').textContent = mode === 'signup' ? T('tn.signup', 'Create account') : T('tn.signin', 'Sign in');
  $('authErr').textContent = '';
  $('authPass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
}
$('tabLogin').addEventListener('click', () => setAuthMode('login'));
$('tabSignup').addEventListener('click', () => setAuthMode('signup'));

/* OAuth 快捷登录：worker 读 referer 判定来源页，回调后原路跳回 /console/
   并种好会话 cookie → 页面加载时 ensureAuth() 探测通过直接进面板。
   OAuth 账号无密码（password_hash=''），这是它们进教师端的唯一通道。 */
$('oauthGoogle').addEventListener('click', () => { location.href = '/api/auth/oauth/google'; });
$('oauthGithub').addEventListener('click', () => { location.href = '/api/auth/oauth/github'; });

const LOGIN_ERRORS = () => ({
  turnstile_failed: T('tn.err_login_turnstile', 'Human check failed — please retry.'),
  invalid_credentials: T('tn.err_login_creds', 'Wrong email or password.'),
  email_not_verified: T('tn.err_login_verify', 'Please verify your email first — we sent you a link when you registered.'),
});
const REGISTER_ERRORS = () => ({
  turnstile_failed: T('tn.err_reg_turnstile', 'Human check failed — please retry.'),
  invalid_email: T('tn.err_reg_email', 'That email address doesn\u2019t look right.'),
  password_too_short: T('tn.err_reg_pwshort', 'Password must be at least 8 characters.'),
  nickname_length_invalid: T('tn.err_reg_name', 'Name must be 2\u201320 characters.'),
  email_already_registered: T('tn.err_reg_exists', 'This email already has an account — switch to Sign in.'),
  ip_register_limit: T('tn.err_reg_iplimit', 'Too many sign-ups from this network today — try again tomorrow.'),
  email_service_unavailable: T('tn.err_reg_emailsvc', 'Sign-up is temporarily unavailable — please try again later.'),
});

$('authSend').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  const password = $('authPass').value;
  if (!email || !password) { showAuth(T('tn.err_fill', 'Email and password are required.')); return; }
  $('authSend').disabled = true;
  $('authErr').textContent = '';
  try {
    if (authMode === 'signup') {
      const nickname = $('authName').value.trim();
      if (nickname.length < 2 || nickname.length > 20) { showAuth(T('tn.err_name_len', 'Please enter your name (2\u201320 characters).')); return; }
      const res = await fetch(API + '/auth/register', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, nickname, turnstile_token: tsToken }),
      });
      const j = await res.json().catch(() => ({}));
      resetTurnstile();
      if (!res.ok) {
        showAuth(REGISTER_ERRORS()[j.error] || (j.error || T('tn.err_signup_failed', 'Sign-up failed')));
        return;
      }
      // 注册成功 → 切回登录，引导去邮箱验证
      $('authPass').value = '';
      setAuthMode('login');
      showAuth(T('tn.err_verify_sent', 'Account created! Check your inbox for the verification link, then sign in here.'));
      return;
    }
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, turnstile_token: tsToken }),
    });
    const j = await res.json().catch(() => ({}));
    resetTurnstile();
    if (!res.ok) {
      showAuth(LOGIN_ERRORS()[j.error] || (j.error || T('tn.err_login_failed', 'Login failed')));
      return;
    }
    hideAuth();
    await boot();
  } catch (e) {
    resetTurnstile();
    showAuth(T('tn.err_network', 'Network error — please retry.'));
  } finally {
    $('authSend').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await fetch(API + '/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
  classes = []; current = null; assignment = null; report = null; roster = [];
  showAuth(T('tn.signed_out', 'Signed out.'));
});

/* ─── boot ─── */
async function boot() {
  try {
    const me = await api('/teacher/me');
    if (me && me.teacher && me.teacher.name) $('who').textContent = '👋 ' + me.teacher.name;
    if (me && me.anonymous) enterAnonMode();
    games = (await api('/teacher/games')).games || [];
    fillGames();
    classes = (await api('/teacher/classes')).classes || [];
    if (!current && classes.length) current = classes[0].id;
    renderRail();
    if (current) await loadClass(current);
    else {
      emptyState();
      toast(T('tn.toast_first_class', 'Create your first class to start'));
    }
  } catch (e) {
    if (e.message !== 'auth_required') toast('⚠ ' + e.message);
  }
}

function fillGames() {
  // M1-UI（2026-10-01）：三站统一教师端 — 按 site 分组（<optgroup>）渲染游戏
  // 数据来源：/api/teacher/games（M1 改造后 11 个游戏，含 board/memory dataReady:false）
  const sel = $('fGame');
  sel.innerHTML = '';
  // 按 site 顺序：numeri → board → memory（主站放第一）
  const order = ['numeri', 'board', 'memory'];
  const bySite = new Map();
  for (const g of games) (bySite.get(g.site) || bySite.set(g.site, []).get(g.site)).push(g);
  for (const site of order) {
    const list = bySite.get(site);
    if (!list || !list.length) continue;
    const grp = document.createElement('optgroup');
    grp.label = ({ numeri: 'NumeriDuel · 数学', board: 'BoardDuel · 棋类', memory: 'MemoryDuel · 知识对抗' })[site] || site;
    for (const g of list) {
      const o = document.createElement('option');
      o.value = g.slug;
      // dataReady:false 加视觉提示（不假装能出报告）
      o.textContent = g.label + (g.note ? ' · ' + g.note : '') + (g.dataReady ? '' : ' · (数据接入中)');
      o.dataset.site = g.site;
      o.dataset.dataReady = g.dataReady ? '1' : '0';
      grp.appendChild(o);
    }
    sel.appendChild(grp);
  }
}

async function loadClass(id) {
  current = id;
  renderRail();
  try {
    roster = (await api('/teacher/classes/' + id + '/roster')).roster || [];
    assignmentList = (await api('/teacher/assignments?classId=' + id)).assignments || [];
  } catch (e) { toast('⚠ ' + e.message); return; }
  // 默认打开最新一份作业；历史作业用 Overview 顶部的下拉切换
  await loadAssignment(assignmentList.length ? assignmentList[assignmentList.length - 1].id : null);
  void loadTrend(id);   // M2：跨作业趋势（独立请求，失败静默降级）
}

/* 加载指定作业的报告（历史切换共用） */
async function loadAssignment(aid) {
  if (!aid) { assignment = null; report = null; renderAsgPicker(); renderOverview(); renderBoard(); return; }
  try {
    const d = await api('/teacher/assignments/' + aid);
    assignment = d.assignment;
    report = d.report;
  } catch (e) { toast('⚠ ' + e.message); return; }
  renderAsgPicker();
  renderOverview();
  renderBoard();
}

/* 作业历史下拉（含再练标记与日期） */
function renderAsgPicker() {
  const sel = $('asgSel');
  const del = $('delAsgBtn');
  if (!sel) return;
  sel.innerHTML = '';
  if (!assignmentList.length) { sel.style.display = 'none'; if (del) del.style.display = 'none'; return; }
  sel.style.display = '';
  if (del) del.style.display = assignment ? '' : 'none';
  assignmentList.slice().reverse().forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id;
    const dt = a.createdAt ? new Date(a.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    const flag = a.targetCount ? ' · ↺' + a.targetCount : '';
    o.textContent = (a.title || a.gameLabel || a.game) + (dt ? ' · ' + dt : '') + flag;
    if (assignment && a.id === assignment.id) o.selected = true;
    sel.appendChild(o);
  });
}

/* ─── render ─── */
function renderRail() {
  const rail = document.querySelector('.rail');
  [...rail.querySelectorAll('.cls')].forEach((n) => n.remove());
  const add = $('addc');
  classes.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'cls' + (c.id === current ? ' on' : '');
    const words = String(c.name || '??').trim().split(/\s+/);
    const code = (words[words.length - 1] || '??').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || '??';
    b.innerHTML = `<span class="ci">${esc(code)}</span><span><span class="cn">${esc(c.name)}</span><br><span class="cs">${esc(c.grade || 'class')}</span></span><span class="cdel" title="${esc(T('tn.delete_class_title', 'Delete class'))}">✕</span>`;
    b.addEventListener('click', () => loadClass(c.id));
    b.querySelector('.cdel').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(T('tn.confirm_del_class', 'Delete class "{name}" with all its assignments and reports? This cannot be undone.', { name: c.name }))) return;
      try {
        await api('/teacher/classes/' + c.id, { method: 'DELETE' });
        classes = classes.filter((x) => x.id !== c.id);
        if (current === c.id) {
          current = classes.length ? classes[0].id : null;
          roster = []; assignmentList = []; assignment = null; report = null;
        }
        if (current) await loadClass(current);
        else { renderRail(); emptyState(); }
        toast(T('tn.toast_class_deleted', '🗑 Class deleted'));
      } catch (e) { toast('⚠ ' + e.message); }
    });
    rail.insertBefore(b, add);
  });
}

function fmtMs(ms) {
  if (!ms) return '—';
  const s = ms / 1000;
  return s >= 60 ? Math.floor(s / 60) + 'm' + String(Math.round(s % 60)).padStart(2, '0') + 's' : s.toFixed(1) + 's';
}

/* ─── M2：跨作业趋势卡（sessions 聚合，最近 12 份作业）─── */
async function loadTrend(cid) {
  if (!cid) return;
  try {
    const d = await api('/teacher/classes/' + cid + '/trend');
    trendCache[cid] = d;
    if (cid === current) renderTrendView();
  } catch (e) { /* 端点异常时不显示趋势卡，不阻塞报告 */ }
}
function renderTrendView() {
  const host = $('trend');
  if (!host) return;
  const d = current ? trendCache[current] : null;
  const pts = ((d && d.points) || []).filter((p) => p.accuracy != null);
  host.style.display = '';
  if (pts.length < 2) {
    host.innerHTML = '<div class="tr-hl">' + T('tn.trend_title', '📊 Progress trend') + '</div><div class="mini">' + T('tn.trend_need_two', 'Finish at least two assignments to see the class trend line.') + '</div>';
    return;
  }
  const W = 560, H = 110, PAD = 10;
  const xs = (i) => PAD + (i * (W - 2 * PAD)) / (pts.length - 1);
  const ys = (v) => H - PAD - (v * (H - 2 * PAD)) / 100;
  const poly = pts.map((p, i) => xs(i).toFixed(1) + ',' + ys(p.accuracy).toFixed(1)).join(' ');
  const dots = pts.map((p, i) => {
    const col = p.accuracy >= 85 ? '#0E9F6E' : p.accuracy >= 60 ? '#F59E0B' : '#DC2626';
    return '<circle cx="' + xs(i).toFixed(1) + '" cy="' + ys(p.accuracy).toFixed(1) + '" r="4.5" fill="' + col + '">' +
      '<title>' + esc(p.title || '') + ' · ' + p.accuracy + '% · ' + p.started + '/' + p.students + ' started</title></circle>';
  }).join('');
  const first = pts[0].accuracy, last = pts[pts.length - 1].accuracy;
  const delta = last - first;
  const arrow = delta > 2 ? '📈 +' + delta : delta < -2 ? '📉 ' + delta : '➖ ' + (delta > 0 ? '+' : '') + delta;
  host.innerHTML = '<div class="tr-hl">' + T('tn.trend_last_n', '📊 Progress trend · last {n} assignments', { n: pts.length }) +
    '<span class="tr-delta">' + arrow + ' ' + T('tn.trend_pts', 'pts') + '</span></div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" class="tr-svg" role="img" aria-label="Class accuracy across assignments">' +
    '<polyline points="' + poly + '" fill="none" stroke="#3730A3" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' + dots + '</svg>' +
    '<div class="tr-x">' + pts.map((p) => '<span>' + esc(String(p.title || '').slice(0, 16)) + '</span>').join('') + '</div>';
}

/* ─── M1：技能热力图（学生 × 技能正确率矩阵，数据来自 24 点自动标签）─── */
const SKILL_LABEL = () => ({ div: T('tn.skill_div', '÷ division'), mul: T('tn.skill_mul', '× multiply'), mix: T('tn.skill_mix', '×± mixed'), bracket: T('tn.skill_bracket', '( ) brackets'), carry: T('tn.skill_carry', 'carry'), borrow: T('tn.skill_borrow', 'borrow') });
function renderSkillMap(rep) {
  const ttl = $('skmTtl');
  const host = $('skillmap');
  if (!ttl || !host) return;
  const sk = (rep && rep.skills) || [];
  const rows = (rep && rep.rows) || [];
  const any = sk.length && rows.some((r) => r.skills && Object.keys(r.skills).length);
  if (!any) { ttl.style.display = 'none'; host.style.display = 'none'; host.innerHTML = ''; return; }
  ttl.style.display = ''; host.style.display = '';
  let html = '<div class="skm"><div class="skm-row skm-head"><span class="skm-code"></span>' +
    sk.map((s) => '<span class="skm-col">' + esc(SKILL_LABEL()[s.tag] || s.tag) + '</span>').join('') + '</div>';
  for (const r of rows) {
    if (!r.skills || !Object.keys(r.skills).length) continue;
    html += '<div class="skm-row"><span class="skm-code">' + esc(r.code) + '</span>' +
      sk.map((s) => {
        const cell = r.skills[s.tag];
        if (!cell) return '<span class="skm-cell na">·</span>';
        const cls = cell.acc >= 80 ? 'good' : cell.acc >= 40 ? 'mid' : 'low';
        const label = SKILL_LABEL()[s.tag] || s.tag;
        return '<span class="skm-cell ' + cls + '" title="' + esc(r.code) + ' · ' + esc(label) + ': ' + cell.ok + '/' + cell.n + ' correct">' + cell.acc + '</span>';
      }).join('') + '</div>';
  }
  html += '</div><div class="mini" style="margin-top:6px">' + T('tn.skm_legend', 'Green ≥80% · amber 40–79 · red &lt;40 · "·" = not attempted yet. Every recommendation starts from evidence you can open and check.') + '</div>';
  host.innerHTML = html;
}

function renderOverview() {
  if (!report || !assignment) { emptyState(); return; }
  const rows = report.rows || [];
  const sm = report.summary || {};
  $('aGame').textContent = assignment.gameLabel || assignment.game;
  $('aMode').textContent = assignment.mode === 'battle' ? T('tn.opt_battle', '🏅 Competition (rated)') : T('tn.opt_practice', '📝 Practice (no rating)');
  $('aDone').textContent = sm.completed || 0;
  $('aTotal').textContent = sm.students || 0;
  $('aPend').textContent = Math.max(0, (sm.students || 0) - (sm.started || 0));
  const due = assignment.dueAt ? new Date(assignment.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  $('aDue').textContent = due ? T('tn.due_on', '📅 due {date}', { date: due }) : T('tn.no_due', '📅 no due');

  // A1：报告首屏先给结论（谁没掌握 / 最难的一批 / 还没开始的人）
  renderInsights(report);
  renderSkillMap(report);   // M1：技能热力图（仅 24 点作业有数据）
  renderTrendView();        // M2：趋势卡（缓存命中即渲染）

  // 班级运算薄弱点（服务端算好的百分比）
  $('weakTtl').textContent = T('tn.weak_ttl', 'Class weak spot') + ' · ' + (assignment.gameLabel || assignment.game);
  const w = $('weak');
  w.innerHTML = '';
  if (!(report.ops || []).length) {
    // 服务端对不上报运算符的游戏（数独/金字塔）返回空 ops —— 不再渲染 0% 假条形
    const msg = assignment.game === '24-game'
      ? T('tn.weak_no_attempts', 'No attempts yet — students need to finish a round first.')
      : T('tn.weak_not_24', 'Operator breakdown applies to 24-Point assignments. Per-student accuracy is shown below.');
    w.innerHTML = '<div class="mini" style="padding:10px 0">' + msg + '</div>';
  } else (report.ops || []).forEach(({ op, sym, v }) => {
    if (op !== 'divide' && op !== 'multiply' && op !== 'add' && op !== 'subtract') return;
    const cls = v < 60 ? 'low' : v < 85 ? 'mid' : 'hi';
    const el = document.createElement('div');
    el.className = 'oprow ' + cls;
    // 冗余编码：条 + 百分比数字 + 高低标识，不单靠红绿区分（色盲友好）
    const mark = v < 60 ? '⚠ ' : v < 85 ? '· ' : '✓ ';
    el.innerHTML = `<span class="op">${esc(sym)}</span><span class="bar"><i style="width:0%"></i></span><span class="pc">${mark}${v}%</span>`;
    w.appendChild(el);
    requestAnimationFrame(() => { el.querySelector('i').style.width = Math.max(0, Math.min(100, v)) + '%'; });
  });

  const g = $('glance');
  g.innerHTML = '';
  [[T('tn.glance_completion', '✅ Completion'), (sm.completion || 0) + '%'],
   [T('tn.glance_acc', '🎯 Avg accuracy'), (sm.avgAcc || 0) + '%'],
   [T('tn.glance_time', '⏱ Avg solve time'), fmtMs(sm.avgMs || 0)],
   [T('tn.glance_started', '👥 Started'), `${sm.started || 0}/${sm.students || 0}`]].forEach(([k, v]) => {
    const el = document.createElement('div');
    el.className = 'oprow hi';
    el.innerHTML = `<span class="op" style="width:auto">${k}</span><span class="mini" style="margin-left:auto;font-family:var(--disp);font-weight:700;color:var(--ink)">${esc(String(v))}</span>`;
    g.appendChild(el);
  });
  const gaps = (report.ops || []).slice().filter(o => ['divide', 'multiply', 'add', 'subtract'].includes(o.op)).sort((a, b) => a.v - b.v);
  const biggest = gaps[0];
  if (!gaps.length) {
    $('glanceNote').textContent = rows.length ? T('tn.note_summary', 'Summary based on accuracy and completion.') : T('tn.note_waiting', 'Waiting for student attempts.');
  } else {
    $('glanceNote').textContent = biggest.v < 70
      ? T('tn.note_gap', '{sym} combinations are the class\u2019s biggest gap — worth a reteach.', { sym: biggest.sym })
      : T('tn.note_ontrack', 'No major gaps — the class is on track.');
  }

  const tb = $('stuBody');
  tb.innerHTML = '';
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="mini" style="padding:14px">' + T('tn.no_students', 'No student codes yet. Add a roster, or let students join with the room code.') + '</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.title = T('tn.row_hint', 'Click for round-by-round detail');
    tr.addEventListener('click', () => openStudent(r.code));
    const doneOk = assignment.rounds ? r.solved >= assignment.rounds : r.solved > 0;
    const ak = r.acc >= 85;
    const weak = r.weak ? `<span class="tagv weak">${esc(r.weak)}</span>` : '<span class="mini">—</span>';
    tr.innerHTML = `<td><div class="stu"><span class="av">${esc(r.code)}</span></div></td>
      <td><span class="tagv ${doneOk ? 'ok' : 'no'}">${r.solved} / ${r.attempted || '—'}</span></td>
      <td><span class="tagv ${ak ? 'ok' : 'no'}">${r.rounds ? r.acc + '%' : '—'}</span></td>
      <td class="mini">${fmtMs(r.avgMs)}</td>
      <td>${weak}</td>`;
    tb.appendChild(tr);
  });
}

function renderBoard() {
  if (!assignment) return;
  const c = classes.find((x) => x.id === current);
  $('bClass').textContent = `${c ? c.name : 'Class'} · ${assignment.gameLabel || assignment.game}`;
  $('bTitle').textContent = assignment.title || '—';
  $('bCode').textContent = assignment.roomCode || '—';
  $('bTime').textContent = `⏱ ${assignment.timeLimit ? assignment.timeLimit + 's' : T('tn.untimed', 'untimed')} · ${T('tn.n_rounds', '{n} rounds', { n: assignment.rounds || '—' })}`;
  $('bDone').textContent = `✅ ${(report && report.summary && report.summary.started) || 0}/${(report && report.summary && report.summary.students) || 0}`;
}

/* ─── A1：洞察面板（报告首屏先给结论）─── */
function renderInsights(rep) {
  const box = $('insights');
  if (!box) return;
  if (!rep || !rep.insights || !rep.insights.items || !rep.insights.items.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const ins = rep.insights;
  box.style.display = '';
  let html = '';
  if (ins.headline) html += `<div class="ins-hl">${esc(ins.headline)}</div>`;
  for (const it of ins.items) {
    const sev = it.severity || 'info';
    let act = '';
    if (it.action && it.action.type === 'reteach') {
      act = '<button class="ins-act" data-act="reteach">' + T('tn.reteach_btn', '↺ Re-teach these') + '</button>';
    } else if (it.action && it.action.type === 'copy_invite') {
      act = '<button class="ins-act" data-act="copy">' + T('tn.copy_invite', '🔗 Copy invite') + '</button>';
    }
    html += `<div class="ins-item sev-${esc(sev)}">`
      + `<span class="ins-ic">${esc(it.icon || '')}</span>`
      + `<div class="ins-tx"><span class="ins-t">${esc(it.text || '')}</span>`
      + (it.detail ? `<span class="ins-d">${esc(it.detail)}</span>` : '')
      + `</div>${act}</div>`;
  }
  box.innerHTML = html;
}

/* ─── A2：从洞察一键生成再练作业 ─── */
async function reteachFromReport() {
  if (!assignment) { toast(T('tn.toast_no_asg', 'No assignment loaded')); return; }
  if (!await ensureAuth()) return;
  try {
    const d = await api('/teacher/assignments/' + assignment.id + '/reteach', { method: 'POST', body: JSON.stringify({}) });
    assignment = d.assignment;
    $('roomCode').textContent = d.roomCode;
    $('roomUrl').textContent = d.inviteUrl;
    $('roomBox').style.display = 'flex';
    $('qrBox').style.display = 'none';
    await loadClass(current);
    toast(T('tn.toast_reteach', '↺ Re-teach room {code} ready for {n} student(s)', { code: d.roomCode, n: d.targetedCount || 0 }));
  } catch (e) { toast('⚠ ' + e.message); }
}

function emptyState() {
  ['aDone', 'aTotal', 'aPend'].forEach((id) => $(id).textContent = '0');
  $('aGame').textContent = '—';
  $('aMode').textContent = '—';
  ['weak', 'glance', 'stuBody'].forEach((s) => $(s).innerHTML = '');
  $('weak').innerHTML = '<div class="mini" style="padding:10px 0">' + T('tn.empty_assign', 'Assign your first practice to see class data.') + '</div>';
  const sel = $('asgSel'); if (sel) { sel.style.display = 'none'; sel.innerHTML = ''; }
  const dab = $('delAsgBtn'); if (dab) dab.style.display = 'none';
  const ib = $('insights');
  if (ib) { ib.style.display = 'none'; ib.innerHTML = ''; }
  const tb = $('trend'); if (tb) { tb.style.display = 'none'; tb.innerHTML = ''; }
  const sm = $('skmTtl'); if (sm) sm.style.display = 'none';
  const skm = $('skillmap'); if (skm) { skm.style.display = 'none'; skm.innerHTML = ''; }
}

/* ─── tabs ─── */
function switchTab(v) {
  const map = { over: 'viewOver', assign: 'viewAssign', board: 'viewBoard', privacy: 'viewPrivacy', banks: 'viewBanks' };
  ['over', 'assign', 'board', 'privacy', 'banks'].forEach((k) => {
    const on = k === v;
    $('tab' + k.charAt(0).toUpperCase() + k.slice(1)).classList.toggle('on', on);
    $(map[k]).style.display = on ? '' : 'none';
  });
  if (v === 'board') { pollLive(); startLive(); }
  else stopLive();
}
$('tabOver').addEventListener('click', () => switchTab('over'));
$('tabAssign').addEventListener('click', () => switchTab('assign'));
$('tabBoard').addEventListener('click', () => switchTab('board'));
$('tabPrivacy').addEventListener('click', () => switchTab('privacy'));
$('boardBtn').addEventListener('click', () => switchTab('board'));

/* A3：练习模式默认不计时 —— 切换 MODE 时启用/禁用计时字段 */
function syncTimeField() {
  const isPrac = $('fMode').value === 'practice';
  $('fTime').disabled = isPrac;
  $('fTime').style.opacity = isPrac ? '.5' : '1';
  const lbl = $('fTimeLbl');
  if (lbl) lbl.textContent = isPrac ? T('tn.f_time_untimed', 'TIME PER ROUND (s) — untimed') : T('tn.f_time', 'TIME PER ROUND (s)');
}
$('fMode').addEventListener('change', syncTimeField);
syncTimeField();   // 默认 practice → 初始即禁用

/* 洞察面板按钮：再练 / 复制邀请（事件委托，避免每次重渲染重复绑定） */
$('insights').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'reteach') { await reteachFromReport(); return; }
  if (btn.dataset.act === 'copy') {
    const txt = (assignment && assignment.inviteUrl) || $('roomUrl').textContent || '';
    if (!txt) { toast('Generate or pick an assignment first'); return; }
    try { await navigator.clipboard.writeText(txt); toast('🔗 Invite copied to clipboard'); }
    catch { toast('🔗 ' + txt); }
  }
});

/* ─── live standings (Board) ─── */
function startLive() { stopLive(); liveTimer = setInterval(pollLive, 5000); }
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

async function pollLive() {
  if (!assignment) return;
  try {
    const d = await api('/teacher/assignments/' + assignment.id + '/live');
    const tb = $('boardBody');
    tb.innerHTML = '';
    const lb = d.leaderboard || [];
    if (!lb.length) {
      tb.innerHTML = '<tr><td colspan="5" class="mini" style="padding:14px">' + T('tn.waiting_join', 'Waiting for students to join…') + '</td></tr>';
    }
    lb.slice(0, 20).forEach((r) => {
      const tr = document.createElement('tr');
      if (r.active) tr.className = 'live';
      tr.innerHTML = `<td class="rk">${r.rank}</td><td><b>${esc(r.code)}</b></td><td>${r.solved}</td><td>${r.rounds ? r.acc + '%' : '—'}</td><td class="mini">${fmtMs(r.avgMs)}</td>`;
      tb.appendChild(tr);
    });
    $('bDone').textContent = `✅ ${d.summary.started}/${d.summary.students}`;
    $('bLive').textContent = T('tn.live_updated', '● live · updated') + ' ' + new Date().toLocaleTimeString();
    $('bLive').className = 'pg on';
  } catch (e) { /* 轮询失败静默，下次再试 */ }
}

/* ─── classes ─── */
$('newc').addEventListener('click', async () => {
  if (!await ensureAuth()) return;
  const name = prompt(T('tn.prompt_class_name', 'Class name (e.g. Class 4B)'));
  if (!name) return;
  const grade = prompt(T('tn.prompt_grade', 'Grade (e.g. Grade 4 / Year 3)'), 'Grade 4');
  try {
    const d = await api('/teacher/classes', { method: 'POST', body: JSON.stringify({ name, grade }) });
    classes.push(d.class);
    await loadClass(d.class.id);
    toast(T('tn.toast_created', 'Created {name}', { name }));
  } catch (e) { toast('⚠ ' + e.message); }
});
$('addc').addEventListener('click', () => $('newc').click());

/* ─── roster ─── */
$('rosterBtn').addEventListener('click', () => {
  const box = $('rosterBox');
  const on = box.style.display !== 'none';
  box.style.display = on ? 'none' : '';
  if (!on) $('rosterTA').value = roster.join('\n');
});

/* ─── Privacy（M3 2026-10-01）：导出 + 删除 ─── */
$('exportBtn')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/teacher/me/export', {
      credentials: 'same-origin',
      headers: { 'X-Anon-Teacher': anonId() },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'teachduel-export.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('⬇ Export ready');
  } catch (e) {
    toast('Export failed — please retry. Your data is safe under 180-day auto-delete.');
  }
});

$('deleteBtn')?.addEventListener('click', async () => {
  if (!confirm(T('tn.priv_delete_confirm', 'Delete ALL my classes, assignments and student records? This cannot be undone.'))) return;
  try {
    const res = await fetch('/api/teacher/me/delete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Anon-Teacher': anonId(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL' }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('🗑 Deleted. Logging out…');
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    toast('Delete failed — please retry, or email privacy@teachduel.com for help.');
  }
});
$('rosterSave').addEventListener('click', async () => {
  try {
    const d = await api('/teacher/classes/' + current + '/roster', {
      method: 'PUT',
      body: JSON.stringify({ codes: $('rosterTA').value.split(/[\s,;]+/).filter(Boolean) }),
    });
    roster = d.roster || [];
    $('rosterBox').style.display = 'none';
    toast(T('tn.toast_roster', '👥 Roster saved — {n} codes', { n: roster.length }));
    await loadClass(current);
  } catch (e) { toast('⚠ ' + e.message); }
});

/* ─── assignment generation：房间码来自服务端 ─── */


/* ════════════ M4-P0 Use my bank 开关（2026-10-01）══════════════
   注入"Use my question bank"复选框 + bankId 分支 */
let assignUseBank = false;

async function setupBankToggle() {
  const fGame = document.getElementById('fGame');
  if (!fGame || document.getElementById('fUseBank')) return;
  const formRow = fGame.closest('.fld');
  if (!formRow) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'grid-column:1/-1;margin:0 0 10px;padding:8px 12px;background:#1a3d4a;border-radius:8px;border:1px solid #26546a;';
  wrap.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.92rem;color:#c0d4d8">
      <input type="checkbox" id="fUseBank" style="width:16px;height:16px;cursor:pointer;accent-color:#0fb5a8">
      <span><b style="color:#fff">Use my question bank</b> <span style="color:#9fbcc8">(CSV-uploaded, P0 student play)</span></span>
    </label>
    <div id="bankPicker" style="display:none;margin-top:8px">
      <select id="fBankId" style="width:100%;padding:6px 8px;background:#0a171b;border:1px solid #26546a;border-radius:6px;color:#e9f3f7;margin-bottom:6px"></select>
      <label style="font-size:.85rem;color:#9fbcc8">Questions per student: <input id="fSampleN" type="number" value="5" min="1" max="30" style="width:60px;padding:3px;margin-left:4px"></label>
    </div>
  `;
  formRow.parentElement.insertBefore(wrap, formRow);

  const cb = document.getElementById('fUseBank');
  cb.onchange = async (e) => {
    assignUseBank = e.target.checked;
    document.getElementById('bankPicker').style.display = assignUseBank ? 'block' : 'none';
    const disabledIds = ['fGame', 'fMode', 'fDiff', 'fRounds', 'fTime', 'fCap'];
    disabledIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = assignUseBank; el.style.opacity = assignUseBank ? '0.5' : '1'; }
    });
    if (assignUseBank) {
      try {
        const d = await api('/teacher/bank');
        const sel = document.getElementById('fBankId');
        const banks = d.banks || [];
        if (!banks.length) {
          sel.innerHTML = '<option value="">— No banks yet (upload one first) —</option>';
          toast('Tip: go to Banks tab → + Upload CSV first');
        } else {
          sel.innerHTML = banks.map(b => `<option value="${b.id}">${esc(b.name)} (${b.count} q)</option>`).join('');
        }
      } catch (e) { toast('⚠ ' + e.message); }
    }
  };
}
setupBankToggle();

async function createBankAssignment() {
  const bankId = document.getElementById('fBankId').value;
  const sampleN = parseInt(document.getElementById('fSampleN').value, 10) || 5;
  if (!bankId) { toast('⚠ Select a bank'); return; }
  try {
    toast('Creating bank assignment…');
    const d = await api('/teacher/assignments', {
      method: 'POST',
      body: JSON.stringify({
        classId: current,
        bankId,
        sampleN,
        game: 'quiz',
        mode: 'practice',
      }),
    });
    if (d.error) throw new Error(d.error);
    assignment = d.assignment;
    document.getElementById('roomCode').textContent = d.playCode;
    document.getElementById('roomUrl').textContent = d.inviteUrl;
    document.getElementById('roomBox').style.display = 'flex';
    document.getElementById('qrBox').style.display = 'none';
    await loadClass(current);
    toast('✅ Play session ready — students open ' + d.inviteUrl);
  } catch (e) { toast('⚠ ' + e.message); }
}

$('genBtn').addEventListener('click', async () => {
  if (!current) { toast(T('tn.toast_pick_class', 'Pick or create a class first')); return; }
  // M1-UI（2026-10-01）：board/memory dataReady:false 时警告教师（不假装能出报告）
  const selOpt = $('fGame').selectedOptions[0];
  if (selOpt && selOpt.dataset.dataReady === '0') {
    toast(T('⚠ {site} 数据接入中，邀请链接可发，但学生成绩暂不计入看板',
      { site: ({ board: 'BoardDuel', memory: 'MemoryDuel' })[selOpt.dataset.site] || selOpt.dataset.site }));
  }
  const dueRaw = $('fDue').value;
  if (assignUseBank) { await createBankAssignment(); return; }
  try {
    const d = await api('/teacher/assignments', {
      method: 'POST',
      body: JSON.stringify({
        classId: current,
        game: $('fGame').value,
        mode: $('fMode').value,
        untimed: $('fMode').value === 'practice',   // A3：练习默认不计时（NCTM 2023）
        difficulty: $('fDiff').value,
        rounds: parseInt($('fRounds').value, 10) || 5,
        timeLimit: parseInt($('fTime').value, 10) || 60,
        maxPlayers: parseInt($('fCap').value, 10) || 30,
        dueAt: dueRaw ? new Date(dueRaw + 'T23:59:00').toISOString() : null,
      }),
    });
    assignment = d.assignment;
    $('roomCode').textContent = d.roomCode;
    $('roomUrl').textContent = d.inviteUrl;
    $('roomBox').style.display = 'flex';
    $('qrBox').style.display = 'none';
    await loadClass(current);
    toast(T('tn.toast_room_ready', '🚀 Room {code} ready — share with the class', { code: d.roomCode }));
  } catch (e) { toast('⚠ ' + e.message); }
});

$('copyBtn').addEventListener('click', async () => {
  const txt = $('roomUrl').textContent;
  try { await navigator.clipboard.writeText(txt); toast(T('tn.toast_invite_copied', '🔗 Invite copied to clipboard')); }
  catch (e) { toast('🔗 ' + txt); }
});

/* QR：用站点自托管库（与游戏内对联 dello stesso），不可扫 = 学生加不进来 */
$('qrBtn').addEventListener('click', () => {
  const box = $('qrBox');
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  box.style.display = '';
  drawQR($('qrCanvas'), $('roomUrl').textContent);
});

/* 投影：新开大屏页（超大房间码 + 入房二维码），课堂一体机/白板直接全屏 */
$('projBtn').addEventListener('click', () => {
  const c = ($('roomCode').textContent || '').trim();
  if (!c) { toast(T('tn.toast_gen_first', 'Generate a room first')); return; }
  const t = (assignment && assignment.title) || '';
  window.open('/teacher/project/?c=' + encodeURIComponent(c) + '&t=' + encodeURIComponent(t), '_blank', 'noopener');
});

function drawQR(cv, text) {
  try {
    const g = window;
    if (typeof g.qrcode !== 'function') throw new Error('no_lib');
    const size = 200;
    cv.width = size; cv.height = size;
    const qr = g.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const mm = qr.getModuleCount();
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('no_ctx');
    const cell = Math.floor(size / mm);
    const off = Math.floor((size - cell * mm) / 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#10142A';
    for (let r = 0; r < mm; r++) {
      for (let c = 0; c < mm; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
      }
    }
  } catch (e) {
    const ctx = cv.getContext('2d');
    if (ctx) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
    toast(T('tn.toast_qr_unavailable', '▦ QR unavailable — use the invite link instead'));
  }
}

/* ─── CSV export ─── */
$('expBtn').addEventListener('click', () => {
  if (!report || !assignment) { toast(T('tn.toast_nothing_export', 'Nothing to export yet')); return; }
  const c = classes.find((x) => x.id === current);
  const rows = [['student_code', 'rounds_solved', 'rounds_attempted', 'accuracy_pct', 'avg_time_s', 'weak_op']];
  (report.rows || []).forEach((r) => rows.push([r.code, r.solved, r.attempted || 0, r.rounds ? r.acc : '', r.avgMs ? (r.avgMs / 1000).toFixed(1) : '', r.weak || '']));
  const csv = rows.map((r) => r.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(c ? c.name : 'class')}-${assignment.roomCode || 'report'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(T('tn.toast_csv', '📊 CSV exported'));
});

/* ─── misc ─── */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
let toastId = null;
function toast(m) { const t = $('toast'); t.textContent = m; t.className = 'toast show'; clearTimeout(toastId); toastId = setTimeout(() => t.classList.remove('show'), 2600); }
async function ensureAuth() {
  try { await api('/teacher/me'); return true; }
  catch (e) { if (e.message !== 'auth_required') toast('⚠ ' + e.message); return false; }
}

/* ─── 作业历史切换 / 删除作业 ─── */
$('asgSel').addEventListener('change', async () => {
  try { await loadAssignment($('asgSel').value); } catch (e) { toast('⚠ ' + e.message); }
});
$('delAsgBtn').addEventListener('click', async () => {
  if (!assignment) return;
  if (!confirm(T('tn.confirm_del_asg', 'Delete this assignment and its report? This cannot be undone.'))) return;
  try {
    await api('/teacher/assignments/' + assignment.id, { method: 'DELETE' });
    toast(T('tn.toast_asg_deleted', '🗑 Assignment deleted'));
    await loadClass(current);
  } catch (e) { toast('⚠ ' + e.message); }
});

/* ─── 学生逐轮下钻弹层 ─── */
async function openStudent(code) {
  if (!assignment) return;
  try {
    const d = await api('/teacher/assignments/' + assignment.id + '/student?code=' + encodeURIComponent(code));
    $('sTitle').textContent = code + ' · ' + (assignment.gameLabel || assignment.game);
    const recs = d.records || [];
    $('sBody').innerHTML = recs.length
      ? '<table><thead><tr><th>' + T('tn.dr_th_round', 'Round') + '</th><th>' + T('tn.dr_th_result', 'Result') + '</th><th>' + T('tn.dr_th_time', 'Time') + '</th><th>' + T('tn.dr_th_ops', 'Ops') + '</th></tr></thead><tbody>'
        + recs.map((r) => '<tr><td>#' + esc(r.round) + '</td><td>'
          + (r.solved ? T('tn.dr_solved', '✅ solved') : T('tn.dr_wrong', '❌ {n} wrong', { n: r.wrong || 0 })) + '</td><td>'
          + (r.solved && r.duration_ms ? fmtMs(r.duration_ms) : '—') + '</td><td class="mini">'
          + (esc((r.ops || []).join(' ')) || '—') + '</td></tr>').join('')
        + '</tbody></table>'
      : '<p class="mini">' + T('tn.dr_no_rounds', 'No rounds recorded yet.') + '</p>';
    $('smodal').style.display = 'flex';
  } catch (e) { toast('⚠ ' + e.message); }
}
$('sClose').addEventListener('click', () => { $('smodal').style.display = 'none'; });
$('smodal').addEventListener('click', (e) => { if (e.target === $('smodal')) $('smodal').style.display = 'none'; });

/* ─── tabs 键盘导航（方向键在 Overview/Assign/Board 间移动）─── */
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const order = ['tabOver', 'tabAssign', 'tabBoard', 'tabPrivacy'];
  const i = order.indexOf(document.activeElement && document.activeElement.id);
  if (i < 0) return;
  const nx = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
  $(nx).focus();
  $(nx).click();
});

/* ─── turnstile 未加载完成时的友好提示（此前只会永远 turnstile_failed）─── */
$('authSend').addEventListener('click', () => {
  if (tsToken === 'skip' && !window.turnstile) {
    showAuth(T('tn.err_turnstile_loading', 'Human check is still loading — wait a few seconds, or use Google/GitHub below.'));
    waitTurnstile();
  }
}, true); /* capture：提示后主 handler 照常执行，token 就绪即正常提交 */

/* 语言切换后重绘：auth 界面 + 计时字段标签 + 已加载的报告视图 */
const redrawI18n = () => {
  try { setAuthMode(authMode); } catch (e) {}
  try { syncTimeField(); } catch (e) {}
  try { if (assignment) { renderOverview(); renderBoard(); } } catch (e) {}
};
window.addEventListener('i18n:ready', redrawI18n);
window.addEventListener('i18n:change', () => {
  redrawI18n();
});

/* screenshot hook: ?view=assign | ?view=board pre-switches tabs */
const v = new URLSearchParams(location.search).get('view');
if (v === 'assign' || v === 'board' || v === 'privacy') switchTab(v);

/* ─── start ─── */
setAuthMode(authMode);   // 初始即按当前语言渲染 auth 文案（authHint/authSend 由 JS 管理，不加 data-i18n）
waitTurnstile();
(async () => { await ensureAuth().then((authed) => { if (!authed) showAuth(); else boot(); }); })();


/* ════════════ M4 Banks · 2026-10-01 ════════════
   CSV 上传 / 分享码生成 / QR 渲染 / 输码 fork */
let banks = [];
let qrScriptLoaded = false;

function loadQRCodeLib() {
  return new Promise((resolve, reject) => {
    if (window.QRCode) return resolve();
    if (qrScriptLoaded) {
      // wait for load
      const iv = setInterval(() => {
        if (window.QRCode) { clearInterval(iv); resolve(); }
      }, 50);
      return;
    }
    qrScriptLoaded = true;
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('qrcode_lib_load_failed'));
    document.head.appendChild(s);
  });
}

async function loadBanks() {
  try {
    const d = await api('/teacher/bank');
    banks = d.banks || [];
    renderBankList();
  } catch (e) { toast('⚠ ' + e.message); }
}

function renderBankList() {
  const grid = $('bankList');
  if (!grid) return;
  if (!banks.length) {
    grid.innerHTML = '<p class="mini" style="color:var(--mute)">No banks yet. Click "+ Upload CSV" to start.</p>';
    return;
  }
  grid.innerHTML = banks.map(b => `
    <div class="card bank-card" data-id="${b.id}" style="border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
        <div style="flex:1">
          <h4 style="margin:0 0 4px;font-size:.98rem">${esc(b.name)}</h4>
          <div class="mini" style="color:var(--mute)">${b.gameType || 'quiz'} · ${b.count} questions · ${fmtRel(b.updatedAt)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" data-act="preview" data-id="${b.id}">Preview</button>
          <button class="btn btn-primary btn-sm" data-act="share" data-id="${b.id}">Share</button>
          <button class="btn btn-ghost btn-sm" data-act="delete" data-id="${b.id}" style="color:var(--danger)">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

$('tabBanks')?.addEventListener('click', () => { switchTab('banks'); loadBanks(); });

$('bankList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === 'preview') return previewBank(id);
  if (btn.dataset.act === 'share') return shareBank(id);
  if (btn.dataset.act === 'delete') return deleteBank(id);
});

async function previewBank(bid) {
  try {
    const d = await api('/teacher/bank/' + bid);
    const b = d.bank;
    const qs = d.questions || [];
    const html = `
      <div class="modal" id="previewModal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px">
        <div class="card" style="max-width:720px;width:100%;max-height:85vh;overflow:auto;background:var(--card);border-radius:14px;padding:20px">
          <h3 style="margin:0 0 12px">${esc(b.name)} · ${b.count} questions</h3>
          <ol style="padding-left:20px;margin:0 0 12px">
            ${qs.map((q, i) => {
              const cs = q.payload?.choices || [];
              const correctIdx = (q.payload?.correct || [])[0];
              return `<li style="margin:8px 0;line-height:1.55">
                <div><b>${esc(q.prompt)}</b></div>
                <div class="mini" style="margin:4px 0;color:var(--mute)">
                  ${cs.map((c, j) => `<span style="${j === correctIdx ? 'color:var(--good);font-weight:600' : ''}">${j+1}. ${esc(c)}${j === correctIdx ? ' ✓' : ''}</span>`).join(' &nbsp; ')}
                </div>
              </li>`;
            }).join('')}
          </ol>
          <button class="btn btn-ghost" id="previewClose">Close</button>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('previewClose').onclick = () => document.getElementById('previewModal').remove();
  } catch (e) { toast('⚠ ' + e.message); }
}

async function shareBank(bid) {
  try {
    const d = await api('/teacher/bank/' + bid + '/share', { method: 'POST' });
    if (d.error) throw new Error(d.error);
    showShareModal(d.code, d.shareUrl);
  } catch (e) { toast('⚠ ' + e.message); }
}

async function showShareModal(code, shareUrl) {
  await loadQRCodeLib();
  const html = `
    <div class="modal" id="shareModal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="card" style="max-width:480px;width:100%;background:var(--card);border-radius:14px;padding:24px;text-align:center">
        <h3 style="margin:0 0 12px">Share this bank</h3>
        <div id="qr" style="display:flex;justify-content:center;margin:12px 0"></div>
        <div style="font-family:ui-monospace,monospace;font-size:1.4rem;letter-spacing:3px;margin:12px 0;color:var(--brand2)">${code.match(/.{1,3}/g).join(' ')}</div>
        <input id="shareUrl" readonly value="${shareUrl}" style="width:100%;padding:8px;font-size:.85rem;background:#0a171b;border:1px solid var(--line);border-radius:6px;color:var(--text);margin-bottom:12px">
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="copyBtn">Copy link</button>
          <button class="btn btn-ghost" id="dlQrBtn">Download QR</button>
          <button class="btn btn-ghost" id="shareCloseBtn">Close</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  // Render QR
  const qrEl = document.getElementById('qr');
  try {
    await window.QRCode.toCanvas(qrEl, shareUrl, { width: 200, margin: 1, color: { dark: '#000', light: '#fff' } });
  } catch (e) {
    qrEl.innerHTML = '<p class="mini">QR rendering failed (offline?)</p>';
  }
  document.getElementById('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(shareUrl); toast('🔗 Copied!'); }
    catch { toast('Copy manually: ' + shareUrl); }
  };
  document.getElementById('dlQrBtn').onclick = () => {
    const canvas = qrEl.querySelector('canvas');
    if (canvas) {
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url; a.download = 'bank-' + code + '.png';
      a.click();
    }
  };
  document.getElementById('shareCloseBtn').onclick = () => document.getElementById('shareModal').remove();
}

async function deleteBank(bid) {
  if (!confirm('Delete this bank? This cannot be undone.')) return;
  // v3 only: client-side filter (server endpoint not yet added)
  banks = banks.filter(b => b.id !== bid);
  renderBankList();
  toast('Bank removed from list (server delete endpoint in next release)');
}

$('uploadCsvBtn')?.addEventListener('click', () => openCSVUpload());
$('importCodeBtn')?.addEventListener('click', () => openImportCode());

async function openCSVUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const name = prompt('Bank name? (max 80 chars)', file.name.replace(/\.csv$/i, '').slice(0, 80));
    if (!name) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', name);
    try {
      toast('Uploading CSV...');
      const res = await fetch('/api/teacher/bank/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Anon-Teacher': anonId() },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
      toast(`✅ Imported ${data.bank.count} questions (${data.format})`);
      await loadBanks();
    } catch (e) { toast('⚠ ' + e.message); }
  };
  input.click();
}

async function openImportCode() {
  const code = (prompt('Enter 6-character share code:') || '').trim().toUpperCase();
  if (!code) return;
  try {
    const info = await fetch(`/api/teacher/share/${code}`, {
      headers: { 'X-Anon-Teacher': anonId() },
    }).then(r => r.json());
    if (info.error) throw new Error(info.error);
    if (!confirm(`Fork "${info.bank.name}" (${info.bank.count} questions) into your library?\n\nForked by: ${info.bank.forkCount} teachers`)) return;
    const d = await api(`/teacher/share/${code}/fork`, { method: 'POST' });
    if (d.error) throw new Error(d.error);
    toast(`✅ Forked "${d.bank.name}"`);
    await loadBanks();
  } catch (e) { toast('⚠ ' + e.message); }
}


/* ════════════ M4-P0 Assign 表单接 bankId（2026-10-01）════════════
   在原有 assignment POST 流程上加"Use my bank"开关：
   - 关：走原逻辑（hardcoded rounds）
   - 开：调用 GET /teacher/bank 列出可用库，选中后 POST /assignments 带 bankId+sampleN
   返回 inviteUrl 后弹窗显示 play URL + QR */
let assignUseBank = false;

function setupAssignBankUI() {
  // Inject a toggle before the existing Game select
  const fGame = document.getElementById('fGame');
  if (!fGame || document.getElementById('fUseBank')) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;padding:8px 10px;background:#1a3d4a;border-radius:8px;';
  wrap.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.95rem">
      <input type="checkbox" id="fUseBank" style="width:18px;height:18px;cursor:pointer">
      <span>Use my question bank (CSV-uploaded)</span>
    </label>
    <div id="bankPicker" style="display:none;margin-top:8px;padding:6px 8px;background:#0a171b;border-radius:6px">
      <select id="fBankId" style="width:100%;padding:6px;margin-bottom:6px"></select>
      <label style="font-size:.85rem;color:#9fbcc8">Questions per student: <input id="fSampleN" type="number" value="5" min="1" max="30" style="width:60px;padding:3px"></label>
    </div>
  `;
  fGame.parentElement.insertBefore(wrap, fGame.parentElement.firstChild);

  document.getElementById('fUseBank').onchange = async (e) => {
    assignUseBank = e.target.checked;
    document.getElementById('bankPicker').style.display = assignUseBank ? 'block' : 'none';
    document.getElementById('fGame').disabled = assignUseBank;
    if (assignUseBank) {
      try {
        const d = await api('/teacher/bank');
        const sel = document.getElementById('fBankId');
        sel.innerHTML = (d.banks || []).map(b => `<option value="${b.id}">${esc(b.name)} (${b.count} q)</option>`).join('') || '<option>No banks yet</option>';
      } catch (e) { toast('⚠ ' + e.message); }
    }
  };
}
setupAssignBankUI();

/* 拦截原有 assign form 提交，加 bankId 处理 */
const _origAssignSubmit = document.querySelector('form')?.onsubmit;
// Hook the existing form: when Use Bank is on, replace body with bankId
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!form || form.id !== 'assignForm') return;
  if (!assignUseBank) return;
  e.preventDefault();
  const classId = $('fClass').value;
  const bankId = $('fBankId').value;
  const sampleN = parseInt($('fSampleN').value) || 5;
  if (!classId) { toast('⚠ Select a class first'); return; }
  if (!bankId) { toast('⚠ Select a bank first'); return; }
  try {
    toast('Creating room from bank…');
    const d = await api('/teacher/assignments', {
      method: 'POST',
      body: JSON.stringify({
        classId, bankId, sampleN,
        game: 'quiz',
        mode: 'practice',
        title: $('Demo Title', $('assignTitle')?.value || ''),
      }),
    });
    if (d.error) throw new Error(d.error);
    // Show play URL modal (reuse share modal)
    if (typeof showShareModal === 'function') {
      showShareModal(d.playCode, d.inviteUrl);
    } else {
      toast('✅ Room created: ' + d.inviteUrl);
    }
  } catch (err) { toast('⚠ ' + err.message); }
}, true);
