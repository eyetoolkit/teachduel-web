/* ════════════ TeachDuel · /play/ 学生答题 SPA ════════════ */
'use strict';

const code = new URL(location.href).searchParams.get('code') || '';
/* sid = 学生代号。服务端按 (code, sid) 存**各自的**进度，并校验名单
   （worker/src/sites/mathduel/services/teacher-play-routes.js resolveStudent）。
   2026-10-06 起必填 —— 此前 sid 缺失会被 400 missing_sid 拒。
   存在 localStorage：同一浏览器重复打开同一份作业时续上自己的进度。 */
const SID_KEY = 'td_play_sid';
let sid = (new URL(location.href).searchParams.get('sid') || '').trim();
if (!sid) { try { sid = (localStorage.getItem(SID_KEY) || '').trim(); } catch {} }

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'omit', ...opts });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || 'HTTP ' + res.status);
    err.code = data && data.error;
    throw err;
  }
  return data;
}

/* 所有请求都要带 sid —— 与服务端契约保持一致，不要在任何分支里裸调 api() */
function withSid(p) {
  return p + (p.indexOf('?') >= 0 ? '&' : '?') + 'sid=' + encodeURIComponent(sid);
}

const state = {
  idx: 0, total: 0, picked: null, correct: null, correctIdx: null,
  finished: false, score: 0, startTs: 0, answered: false,
};

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ─── 代号输入闸 ───
   必须先确认「你是谁」，才能开始答题 —— 服务端据此分存进度与查名单。
   名单非空时不在册会被 403 not_on_roster，这里提前把话说清楚。 */
function askSid() {
  return new Promise((resolve) => {
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="sid-gate">
        <div class="q-prompt" style="margin-top:8px">你是谁？</div>
        <div class="meta" style="margin-bottom:16px">输入你的代号（学号 / 姓名），老师用它记录你的成绩。</div>
        <input id="sidInput" class="sid-input" maxlength="12" autocomplete="off"
               placeholder="例如 S01" value="${escHtml(sid)}" />
        <button class="next" id="sidBtn" style="width:100%;margin-top:14px">开始答题 →</button>
        <div id="sidErr" class="feedback bad" style="display:none"></div>
      </div>`;
    const input = document.getElementById('sidInput');
    const errBox = document.getElementById('sidErr');
    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        errBox.style.display = 'block';
        errBox.textContent = '请输入代号';
        return;
      }
      sid = v;
      try { localStorage.setItem(SID_KEY, v); } catch {}
      resolve(v);
    };
    document.getElementById('sidBtn').onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    try { input.focus(); } catch {}
  });
}

async function load() {
  if (!code) {
    document.getElementById('app').innerHTML = '<div class="err"><b>Missing code</b><p style="margin:6px 0 0;font-size:.92rem">Open this page with ?code=XXX shared by your teacher.</p></div>';
    return;
  }
  if (!sid) { await askSid(); }
  try {
    const d = await api(withSid('/api/play/' + code));
    if (d.finished) {
      showFinished(d.score, d.total);
      return;
    }
    state.idx = d.idx; state.total = d.total; state.startTs = Date.now();
    render(d);
  } catch (e) {
    showFatal(e);
  }
}

/* 身份类错误要给出可行动的提示，而不是干巴巴一个 error code */
function showFatal(e) {
  const app = document.getElementById('app');
  const hint = {
    missing_sid: '需要先输入代号。请点下方按钮重新输入。',
    not_on_roster: '你的代号不在老师这份名单里。请确认代号拼写，或向老师确认。',
    not_targeted: '这份作业不是给你的。请向老师确认是否选错了。',
    expired: '这份作业已经截止了。',
    session_ended: '老师已经结束了这次答题。',
    session_not_found: '找不到这次答题。请确认链接是否完整。',
    room_not_found: '找不到这次作业。请重新打开老师发的完整链接。',
    assignment_not_found: '作业已被老师删除。',
    rate_limited: '操作太快了，请稍等几秒再试。',
  }[e.code] || '';
  app.innerHTML = `
    <div class="err">
      <b>无法开始答题</b>
      <p style="margin:8px 0 0;font-size:.92rem">${escHtml(hint || e.message)}</p>
    </div>
    ${e.code === 'missing_sid' ? '<button class="next" id="retrySid" style="width:100%;margin-top:14px">重新输入代号</button>' : ''}`;
  const btn = document.getElementById('retrySid');
  if (btn) btn.onclick = async () => { sid = ''; await askSid(); load(); };
}

function render(d) {
  const app = document.getElementById('app');
  const q = d.question;
  const pct = Math.round((d.progress / d.total) * 100);
  app.innerHTML = `
    <div class="meta">
      Question ${d.idx} of ${d.total}
      <span class="timer">${q.timeLimit}s limit</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="q-prompt">${escHtml(q.prompt)}</div>
    <div class="choices" id="choices">
      ${q.choices.map((c, i) => `<button class="choice" data-idx="${i}">${escHtml(c)}</button>`).join('')}
    </div>
    <div id="feedback"></div>
    <div class="controls">
      <span></span>
      <button class="next" id="nextBtn" disabled>Next →</button>
    </div>
  `;
  document.querySelectorAll('.choice').forEach(b => {
    b.onclick = () => onPick(parseInt(b.dataset.idx));
  });
  document.getElementById('nextBtn').onclick = () => next();
  state.picked = null;
  state.correct = null;
  state.answered = false;
}

async function onPick(picked) {
  if (state.answered) return;
  state.picked = picked;
  state.answered = true;
  const duration = Date.now() - state.startTs;
  try {
    const d = await api(withSid('/api/play/' + code + '/answer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ picked, duration_ms: duration }),
    });
    state.correct = d.correct;
    state.correctIdx = d.correctIdx;
    state.score = d.score;
    // Highlight
    document.querySelectorAll('.choice').forEach(b => {
      const i = parseInt(b.dataset.idx);
      b.disabled = true;
      if (i === d.correctIdx) b.classList.add('correct');
      if (i === picked && !d.correct) b.classList.add('wrong');
      if (i === picked) b.classList.add('picked');
    });
    document.getElementById('feedback').innerHTML = `
      <div class="feedback ${d.correct ? 'ok' : 'bad'}">
        ${d.correct ? '✓ Correct!' : '✗ Not quite.'} &nbsp; Score: ${d.score}/${d.idx}
      </div>
    `;
    const nb = document.getElementById('nextBtn');
    nb.disabled = false;
    nb.textContent = d.finished ? 'See results' : 'Next →';
  } catch (e) {
    document.getElementById('feedback').innerHTML = '<div class="feedback bad">⚠ ' + escHtml(e.message) + '</div>';
    state.answered = false;
  }
}

async function next() {
  if (state.correct === null) return;
  try {
    const d = await api(withSid('/api/play/' + code));
    if (d.finished) {
      showFinished(state.score, d.total);
      return;
    }
    state.idx = d.idx; state.total = d.total; state.startTs = Date.now();
    render(d);
  } catch (e) {
    if (e.code === 'already_finished' || e.code === 'session_ended') {
      showFinished(state.score, state.total);
      return;
    }
    showFatal(e);
  }
}

function showFinished(score, total) {
  const pct = total ? Math.round((100 * score) / total) : 0;
  const msg = pct >= 80 ? '🎉 Excellent!' : pct >= 60 ? '👍 Good work!' : '💪 Keep practicing!';
  document.getElementById('app').innerHTML = `
    <div class="finished">
      <div style="font-size:1.1rem;color:#9fbcc8">All done!</div>
      <div class="score">${score} / ${total}</div>
      <div style="font-size:1.4rem;color:#38d9c9;margin-bottom:24px">${pct}% · ${msg}</div>
      <div class="meta" style="margin-bottom:16px">代号 ${escHtml(sid)}</div>
      <a href="https://teachduel.com" class="brand">Done →</a>
    </div>
  `;
}

load();
