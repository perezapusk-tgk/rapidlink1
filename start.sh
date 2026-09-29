#!/bin/sh
# Start Command на Render:  sh start.sh
set -e
: "${DATA_DIR:=/tmp/rapidlink}"
export DATA_DIR
mkdir -p "$DATA_DIR"

if [ -n "$LITESTREAM_BUCKET" ] && [ -x ./litestream ]; then
  # 1) подтянуть последние данные из облака (если они там уже есть)
  ./litestream restore -if-db-not-exists -if-replica-exists -config litestream.yml "$DATA_DIR/app.db"
  ./litestream restore -if-db-not-exists -if-replica-exists -config litestream.yml "$DATA_DIR/platform.db"
  # 2) если данных нигде нет (самый первый запуск) — создать чистые базы
  node ensure-db.js
  # 3) запустить сервер под присмотром litestream: он копирует изменения в облако
  exec ./litestream replicate -config litestream.yml -exec "node server.js"
else
  echo "!!! LITESTREAM_BUCKET не задан: данные НЕ сохраняются между перезапусками !!!"
  node ensure-db.js
  exec node server.js
fi
