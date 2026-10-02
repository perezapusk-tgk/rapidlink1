#!/bin/sh
# Стартовая команда Render: sh start.sh
set -e
export APP_DIR="$(pwd)"

echo "→ boot.js: проверяю базы и восстанавливаю из зашифрованной копии..."
node boot.js

echo "→ запускаю Torclix Group..."
exec node server.js
