#!/bin/sh
# Build Command на Render:  npm install && sh install-litestream.sh
set -e
VER=0.3.13
if [ ! -x ./litestream ]; then
  curl -fsSL -o litestream.tar.gz "https://github.com/benbjohnson/litestream/releases/download/v${VER}/litestream-v${VER}-linux-amd64.tar.gz"
  tar -xzf litestream.tar.gz litestream
  rm -f litestream.tar.gz
fi
./litestream version
