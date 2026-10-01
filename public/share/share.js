/* ════════════ TeachDuel · Public bank share landing page ════════════ */
'use strict';

async function apiAnon(path, opts = {}) {
  let anon = localStorage.getItem('md_teacher_anon');
  if (!anon) {
    anon = 'a-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    localStorage.setItem('md_teacher_anon', anon);
  }
  const headers = { 'X-Anon-Teacher': anon, ...(opts.headers || {}) };
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return data;
}

const code = location.pathname.split('/').filter(Boolean).pop();

async function load() {
  if (!code || !/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,8}$/.test(code)) {
    document.getElementById('app').innerHTML = '<h1>Invalid share code</h1><p style="color:#9fbcc8">Codes are 4-8 letters/numbers (no 0/O/1/I/L).</p>';
    return;
  }
  try {
    const info = await apiAnon('/api/teacher/share/' + code);
    const b = info.bank;
    document.getElementById('app').innerHTML = `
      <h1>${escHtml(b.name)}</h1>
      <div class="meta">
        <span class="badge">${escHtml(b.gameType || 'quiz')}</span>
        by ${escHtml(b.ownerNickname)} · ${b.count} questions
      </div>
      <p class="desc">${escHtml(b.description || 'A question bank shared by another teacher. Fork it into your library to use in your own assignments.')}</p>
      <button id="forkBtn">Fork to my library</button>
      <div class="forkcount">${b.forkCount} teacher${b.forkCount === 1 ? '' : 's'} already using this bank</div>
    `;
    document.getElementById('forkBtn').onclick = async () => {
      const btn = document.getElementById('forkBtn');
      btn.disabled = true; btn.textContent = 'Forking…';
      try {
        const d = await apiAnon('/api/teacher/share/' + code + '/fork', { method: 'POST' });
        location.href = 'https://teachduel.com/console/?forked=' + d.bank.id;
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Fork to my library';
        alert('Fork failed: ' + e.message);
      }
    };
  } catch (e) {
    document.getElementById('app').innerHTML = '<div class="err"><h1 style="margin:0 0 8px">Bank not found or revoked</h1><p style="margin:0;font-size:.92rem">Codes are case-sensitive. Double-check with the teacher who shared it.</p></div>';
  }
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

load();
