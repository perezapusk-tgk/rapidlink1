#!/bin/sh
# Стартовая команда Render: sh start.sh
set -e
export APP_DIR="$(pwd)"
if [ -n "$LITESTREAM_BUCKET" ] && [ -x ./litestream ]; then
  echo "→ Litestream: восстанавливаю базы из резервной копии (если она есть)..."
  ./litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists "$APP_DIR/app.db"
  ./litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists "$APP_DIR/platform.db"
  echo "→ Litestream: запускаю сервер с непрерывным копированием..."
  exec ./litestream replicate -config litestream.yml -exec "node server.js"
else
  echo "!!! Litestream не настроен: данные будут теряться при каждом перезапуске Render."
  exec node server.js
fi
