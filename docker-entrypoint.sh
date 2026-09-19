#!/bin/sh
# 컨테이너 기동 시 매번 실행됨: 마이그레이션 적용 + 부트스트랩 계정 시드(둘 다 멱등) 후 서버 시작.
# e2e/scripts/prepare-and-start.mjs와 동일한 순서(migrate deploy -> seed -> start)를 따른다.
set -e

# 이미지 빌드 시 node 소유로 만들어 두지만, bind mount로 덮이면 호스트 디렉터리가 그대로 보인다.
# 이때 쓰기 권한이 없으면 여기서 명확한 메시지와 함께 멈추는 편이 낫다(§7.2, README 배포 절 참고).
mkdir -p /app/server/prisma/data /app/server/backups 2>/dev/null || true
for dir in /app/server/prisma/data /app/server/backups; do
  if [ ! -w "$dir" ]; then
    echo "[entrypoint] '$dir' 에 쓸 수 없습니다. 호스트 디렉터리 소유자를 uid/gid 1000으로 맞춰 주세요:" >&2
    echo "[entrypoint]   mkdir -p data/db data/backups && sudo chown -R 1000:1000 data" >&2
    exit 1
  fi
done

cd /app/server

echo "[entrypoint] 마이그레이션 적용 중..."
npx prisma migrate deploy

echo "[entrypoint] 부트스트랩 계정 시드 중(이미 있으면 건너뜀)..."
npx tsx prisma/seed.ts

echo "[entrypoint] 서버 시작..."
exec node dist/index.js
