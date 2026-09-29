// node scripts/check-html.js public/studio.html — ищет причину «кнопка входа не работает»
const fs = require('fs');
const f = process.argv[2] || 'public/studio.html';
const s = fs.readFileSync(f, 'utf8');
const open = (s.match(/<script\b/gi) || []).length, close = (s.match(/<\/script>/gi) || []).length;
console.log('<script>: ' + open + ', </script>: ' + close);
if (open !== close) console.log('ПРОБЛЕМА: теги не парные — лишний </script> обрывает JS до привязки кнопки.');
[...s.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m, i) => {
  try { new Function(m[1]); console.log('блок ' + (i + 1) + ': синтаксис OK'); }
  catch (e) { console.log('блок ' + (i + 1) + ': ОШИБКА -> ' + e.message); }
});
if (!/id=["']loginBtn["']/.test(s)) console.log('ПРОБЛЕМА: нет элемента #loginBtn');
