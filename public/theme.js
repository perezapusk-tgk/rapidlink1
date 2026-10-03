/* Torclix Backups — переключатель тёмной/светлой темы.
   Кнопка вставляется в .page-head (шапка страницы) или nav.top.
   Не создаёт плавающих элементов — только встроенная иконка в шапке. */
(function () {
  'use strict';

  var KEY = 'torclix_theme';
  var root = document.documentElement;

  function getTheme() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) {}
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
  }

  function applyTheme(theme) {
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    var btns = document.querySelectorAll('.theme-toggle-inline');
    btns.forEach(function (btn) {
      btn.textContent = theme === 'light' ? '🌙' : '☀️';
      btn.setAttribute('aria-label', theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему');
      btn.setAttribute('title', theme === 'light' ? 'Тёмная тема' : 'Светлая тема');
    });
  }

  function toggle() {
    var current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    var next = current === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    applyTheme(next);
  }

  applyTheme(getTheme());

  function insertToggles() {
    var containers = document.querySelectorAll('.page-head, nav.top .wrap, nav .wrap');
    containers.forEach(function (c) {
      if (c.querySelector('.theme-toggle-inline')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-toggle-inline';
      btn.addEventListener('click', toggle);
      btn.style.cssText = [
        'width:38px',
        'height:38px',
        'border-radius:10px',
        'border:1px solid var(--line-2)',
        'background:var(--card)',
        'color:var(--fg)',
        'cursor:pointer',
        'font-size:1rem',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'padding:0',
        'transition:border-color .2s, background .2s',
        'flex-shrink:0',
        'font-family:inherit'
      ].join(';');
      btn.addEventListener('mouseenter', function () {
        btn.style.borderColor = 'var(--accent)';
        btn.style.background = 'var(--accent-dim)';
      });
      btn.addEventListener('mouseleave', function () {
        btn.style.borderColor = 'var(--line-2)';
        btn.style.background = 'var(--card)';
      });
      var logoutBtn = c.querySelector('#logoutBtn, .btn-ghost');
      if (logoutBtn && logoutBtn.parentElement === c) {
        c.insertBefore(btn, logoutBtn);
      } else {
        c.appendChild(btn);
      }
    });
    applyTheme(getTheme());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertToggles);
  } else {
    insertToggles();
  }
})();
