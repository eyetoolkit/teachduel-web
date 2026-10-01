/* TeachDuel · 站点 chrome 接线（vanilla，所有营销页共用）
 * 与 boardduel lobby-chrome 同思路：移动端 burger 抽屉 / overlay 关闭 / Esc 关闭、
 * 桌面收起（rail）。教学站为单套暗色皮肤，不含主题切换。
 * DOM 依赖：#burger / #overlay / #collapse（缺失则静默跳过）。
 */
(function () {
  'use strict';
  var burger = document.getElementById('burger');
  var overlay = document.getElementById('overlay');
  var collapse = document.getElementById('collapse');

  function close() {
    document.body.classList.remove('nav-open');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }

  if (burger) {
    burger.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      burger.setAttribute('aria-expanded', String(open));
    });
  }
  if (overlay) overlay.addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });
  if (collapse) collapse.addEventListener('click', function () {
    document.body.classList.toggle('rail');
  });
})();
