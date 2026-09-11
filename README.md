# BoardBite POS

학교 반 부스에서 운영하는 보드게임 카페형 행사를 위한 **테이블오더 + KDS(주방) + POS + 정산** 통합 시스템.

> 인증/RBAC/테이블/메뉴/주문(Phase 2), 주방 KDS(Phase 3), 서빙(Phase 4), 부분/복합/더치/상품별 결제와 정산(Phase 5), 결제수단·운영설정·매출현황·백업 등 관리자 고도화(Phase 6)까지 구현되어 있습니다. 남은 것은 안정화(Phase 7: 실기기 테스트, E2E 자동화, 운영 매뉴얼)입니다. 진행 상황은 [`docs/DEVLOG.md`](docs/DEVLOG.md)와 [`docs/HANDOFF.md`](docs/HANDOFF.md)에서 확인할 수 있습니다.

## 운영 흐름 요약

```text
손님 입장 → FRONT 자리 배정 → 테이블 OPEN → 고객 NFC/QR 주문
→ 주방(KDS) 접수/조리 → SERVING 서빙 완료 → FRONT 정산(부분/복합/더치/상품별)
→ 잔액 0 → 고객 세션 폐기 → 테이블 자동 CLOSE
```

## 문서

| 문서 | 설명 |
|---|---|
| [AGENTS.md](AGENTS.md) | 개발 에이전트 운영 규칙 |
| [요구사항.md](요구사항.md) | 전체 기능 요구사항 |
| [docs/RESEARCH.md](docs/RESEARCH.md) | 벤치마크 조사 (OKPOS/배민/KDS/UX/보안) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 아키텍처, 데이터 모델, 상태 머신 |
| [docs/SECURITY.md](docs/SECURITY.md) | 위협 모델 및 보안 대응 |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | 테스트 계획 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 부스 운영 매뉴얼 |
| [docs/HANDOFF.md](docs/HANDOFF.md) | 다음 작업자를 위한 인수인계 |
| [docs/adr/](docs/adr/) | 아키텍처 결정 기록 (ADR) |

## 기술 스택

Node.js(TypeScript) + Express + Prisma + SQLite + React(Vite) + Socket.IO. 선택 이유는 [`docs/adr/0001-tech-stack.md`](docs/adr/0001-tech-stack.md) 참고.

## 로컬 실행

요구사항: Node.js 20 이상.

```bash
npm install

# 환경변수 준비
cp .env.example .env
# .env를 열어 ADMINID/ADMINPASSWORD 등 값과 SESSION_SECRET을 실제 값으로 채운다.
# DATABASE_URL은 반드시 ?connection_limit=1을 포함해야 한다 — 결제 동시성 제어의 핵심 전제다.
# (이유: docs/adr/0005-sqlite-write-concurrency.md)

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

## 기본 계정 (부트스트랩)

`.env.example` 참고. 실제 배포 전 반드시 비밀번호를 변경합니다.

## 라이선스

[MIT](LICENSE)
