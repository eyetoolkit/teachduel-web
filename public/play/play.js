/* ════════════ TeachDuel · /play/ 学生答题 SPA ════════════ */
'use strict';

const code = new URL(location.href).searchParams.get('code') || '';

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'omit', ...opts });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return data;
}

const state = {
  idx: 0, total: 0, picked: null, correct: null, correctIdx: null,
  finished: false, score: 0, startTs: 0, answered: false,
};

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function load() {
  if (!code) {
    document.getElementById('app').innerHTML = '<div class="err"><b>Missing code</b><p style="margin:6px 0 0;font-size:.92rem">Open this page with ?code=XXX shared by your teacher.</p></div>';
    return;
  }
  try {
    const d = await api('/api/play/' + code);
    if (d.finished) {
      showFinished(d.score, d.total);
      return;
    }
    state.idx = d.idx; state.total = d.total; state.startTs = Date.now();
    render(d);
  } catch (e) {
    document.getElementById('app').innerHTML = '<div class="err"><b>Cannot load question</b><p style="margin:6px 0 0;font-size:.92rem">' + escHtml(e.message) + '</p></div>';
  }
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
    const d = await api('/api/play/' + code + '/answer', {
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
    const d = await api('/api/play/' + code);
    if (d.finished) {
      showFinished(state.score, d.total);
      return;
    }
    state.idx = d.idx; state.total = d.total; state.startTs = Date.now();
    render(d);
  } catch (e) {
    document.getElementById('app').innerHTML = '<div class="err">' + escHtml(e.message) + '</div>';
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
      <a href="https://teachduel.com" class="brand">Done →</a>
    </div>
  `;
}

load();
