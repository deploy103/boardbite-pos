# BoardBite POS

학교 반 부스에서 운영하는 보드게임 카페형 행사를 위한 **테이블오더 + KDS(주방) + POS + 정산** 통합 시스템.

> 인증/RBAC/테이블/메뉴/주문(Phase 2), 주방 KDS(Phase 3), 서빙(Phase 4), 부분/복합/더치/상품별 결제와 정산(Phase 5), 결제수단·운영설정·매출현황·백업 등 관리자 고도화(Phase 6), 안정화(Phase 7)까지 구현되어 있습니다.

## 운영 흐름 요약

```text
손님 입장 → FRONT 자리 배정 → 테이블 OPEN → 고객 NFC/QR 주문
→ 주방(KDS) 접수/조리 → SERVING 서빙 완료 → FRONT 정산(부분/복합/더치/상품별)
→ 잔액 0 → 고객 세션 폐기 → 테이블 자동 CLOSE
```

## 기술 스택

Node.js(TypeScript) + Express + Prisma + SQLite + React(Vite) + Socket.IO.

## 로컬 실행

요구사항: Node.js 20 이상.

```bash
npm install

# 환경변수 준비
cp .env.example .env
# .env를 열어 ADMINID/ADMINPASSWORD 등 값과 SESSION_SECRET을 실제 값으로 채운다.
# DATABASE_URL은 반드시 ?connection_limit=1을 포함해야 한다 — 결제 동시성 제어의 핵심 전제다.

# 최초 1회: DB 마이그레이션 + 부트스트랩 계정 시드
npm run prisma:migrate --workspace server

# 개발 서버 (터미널 두 개)
npm run dev:server   # http://localhost:3000 — API + Socket.IO
npm run dev:client   # http://localhost:5173 — /api, /socket.io는 3000으로 프록시
```

로그인은 `/staff/login`에서 `.env`에 채운 `ADMINID/ADMINPASSWORD`(또는 FRONT/POS/SERVING 계정)로 진행하며,
서버가 역할을 판정해 `/admin`, `/front`, `/pos`, `/serving`으로 자동 이동시킨다.

손님 화면은 ADMIN에서 생성한 테이블의 `publicSlug`로 `/t/<slug>` 경로에 접속해 확인한다.

### 프로덕션 유사 실행 (단일 프로세스)

```bash
npm run build:client
npm run build:server
npm run --workspace server start   # client/dist를 정적 서빙 + API + Socket.IO를 한 프로세스에서 제공
```

### 테스트

```bash
cd server && npx vitest run
```

격리된 SQLite 테스트 DB(`server/prisma/test.db`)를 자동으로 생성/정리하며, 개발용 `.env`나 `dev.db`에 영향을 주지 않는다.

### E2E 테스트 (Playwright)

```bash
cd e2e && npx playwright install chromium   # 최초 1회
cd .. && npm run test:e2e
```

클라이언트 빌드 + 격리된 DB(`server/prisma/e2e.db`) + 실제 서버 기동까지 자동으로 처리한다(`e2e/scripts/prepare-and-start.mjs`). 여러 역할(FRONT/POS/SERVING/손님)의 실제 브라우저 흐름을 검증한다.

## Docker로 서버에 배포

```bash
git clone <저장소 URL> && cd Class_Store_Kiosk
cp .env.example .env   # 값 채우기 (특히 ADMINID/PW류, SESSION_SECRET)
docker compose up -d --build
```

빌드, DB 마이그레이션, 부트스트랩 계정 시드까지 이 한 번의 명령으로 끝난다.

- SQLite DB와 백업 파일은 `./data/db`, `./data/backups`에 저장되어 컨테이너를 내렸다 올려도 유지된다.
- `curl http://localhost:${HOST_PORT:-3000}/healthz` → `{"ok":true}`면 정상 기동된 것이다.
- 세션 쿠키는 `NODE_ENV=production`에서 `Secure` 속성이 강제되므로, **HTTPS를 종단하는 리버스 프록시(Nginx 등)
  뒤에서 이 컨테이너로 프록시하는 구성**을 전제로 한다. 프록시 없이 평문 HTTP로 직접 노출하면 로그인이 되지 않는다.
- 포트를 바꾸려면 `.env`에 `HOST_PORT=<포트>`를 추가한다(컨테이너 내부 포트는 항상 3000).
- 코드 업데이트 후 재배포: `git pull && docker compose up -d --build` (마이그레이션/시드는 멱등이라 반복 실행해도 안전).

## 기본 계정 (부트스트랩)

`.env.example` 참고. 실제 배포 전 반드시 비밀번호를 변경합니다.

## 라이선스

[MIT](LICENSE)
