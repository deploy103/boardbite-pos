# syntax=docker/dockerfile:1
#
# 단일 컨테이너로 전체 앱(server + client 정적 파일)을 서빙한다.
# server/src/app.ts가 client/dist를 그대로 static serve하는 구조(docs/ARCHITECTURE.md)를
# 그대로 따르므로, 이미지 안에서도 server/와 client/가 형제 디렉터리로 있어야 한다.

FROM node:22-bookworm-slim AS base
# Prisma 쿼리 엔진(OpenSSL 의존)이 debian slim 이미지에서 정상 동작하려면 필요
# (https://www.prisma.io/docs/orm/reference/system-requirements 권고 사항).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------- 의존성 설치 + 빌드 ----------
FROM base AS build

# package.json들만 먼저 복사해 npm ci 레이어를 캐싱한다(소스만 바뀌면 재설치 안 함).
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
COPY e2e/package.json e2e/package.json
RUN npm ci

COPY server server
COPY client client

# prisma generate는 DATABASE_URL의 "값"은 쓰지 않고 스키마만 읽지만, 존재 자체는 확인하므로
# 빌드 전용 더미 값을 넣어준다(실제 런타임 값은 docker-compose.yml의 environment가 덮어씀).
ENV DATABASE_URL="file:./build-time-placeholder.db?connection_limit=1"
RUN cd server && npx prisma generate

RUN npm run build --workspace client
RUN npm run build --workspace server

# devDependencies(vite/vitest/typescript/playwright 등) 제거 — prisma/tsx는 런타임에
# 마이그레이션/시드를 실행해야 해서 server/package.json에서 dependencies로 옮겨둠.
RUN npm prune --omit=dev

# ---------- 런타임 ----------
FROM base AS runtime
ENV NODE_ENV=production

# 요구사항2.md §7.2 — 애플리케이션은 non-root로 실행한다.
# node 이미지에 이미 있는 uid/gid 1000(node) 사용자를 그대로 쓴다. 호스트 bind mount의
# 소유자도 1000:1000이어야 하며, README "배포" 절에 필요한 chown 명령을 안내한다.
COPY --from=build --chown=root:root /app /app
COPY --chown=root:root docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
    # 애플리케이션 소스는 root 소유 + 읽기 전용으로 두고, 쓰기가 필요한 디렉터리만 node에게 넘긴다.
    && mkdir -p /app/server/prisma/data /app/server/backups \
    && chown -R node:node /app/server/prisma/data /app/server/backups

USER node

EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
