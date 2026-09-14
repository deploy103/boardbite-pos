#!/bin/sh
# 컨테이너 기동 시 매번 실행됨: 마이그레이션 적용 + 부트스트랩 계정 시드(둘 다 멱등) 후 서버 시작.
# e2e/scripts/prepare-and-start.mjs와 동일한 순서(migrate deploy -> seed -> start)를 따른다.
set -e

mkdir -p /app/server/prisma/data /app/server/backups

cd /app/server

echo "[entrypoint] 마이그레이션 적용 중..."
npx prisma migrate deploy

echo "[entrypoint] 부트스트랩 계정 시드 중(이미 있으면 건너뜀)..."
npx tsx prisma/seed.ts

echo "[entrypoint] 서버 시작..."
exec node dist/index.js
