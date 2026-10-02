/* Torclix Backups — переключение темы */
(function () {
  function get() { try { return localStorage.getItem('Torclix Backups_theme'); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem('Torclix Backups_theme', v); } catch (e) {} }
  var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.setAttribute('data-theme', get() || (prefersLight ? 'light' : 'dark'));

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.createElement('button');
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', 'Переключить тему');
    btn.title = 'Тёмная / светлая тема';
    function setIcon() { btn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '🌙' : '☀️'; }
    setIcon();
    btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      set(next); setIcon();
    });
    document.body.appendChild(btn);
  });
})();
