# 0001 — 기술 스택 선택

- 상태: 채택됨
- 날짜: 2026-09-11
- 관련 문서: `docs/RESEARCH.md`, `docs/adr/0002-realtime-communication.md`

## 배경

BoardBite POS는 다음 제약 조건을 만족해야 한다 (`AGENTS.md`, `요구사항.md` 기준).

- 고객은 모바일 웹(주로 iPhone Safari)으로 접속 — 네이티브 앱 설치 불필요
- 직원은 iPad/태블릿/PC 브라우저 사용
- 주문/조리/서빙 상태가 실시간에 가깝게 갱신되어야 함
- 결제/정산 데이터는 트랜잭션 일관성이 반드시 보장되어야 함(부분결제, 동시 결제)
- 학교 부스 환경에서 비전문가도 쉽게 배포/재시작/백업할 수 있어야 함
- 복잡도가 과도하지 않아야 함(짧은 개발 기간, 소수 인원 운영)
- Public GitHub repo로 관리, Linux 서버에 배포 가능, HTTPS 운영 가능

## 후보 비교

### 후보 A — Node.js(TypeScript) + Express + Prisma + SQLite + React(Vite) + Socket.IO

**장점**
- 프론트엔드(React/TS)와 백엔드(Node/TS) 언어를 통일해 컨텍스트 스위칭과 타입 공유(예: 공용 타입 패키지)가 쉬움.
- Prisma는 스키마 마이그레이션, 타입 안전 쿼리, 트랜잭션 API(`prisma.$transaction`)를 기본 제공해 결제 동시성 로직 구현이 명확함.
- SQLite는 파일 하나가 곧 DB이므로 "서버 종료 후 파일 복사"만으로 백업이 가능 — 학교 부스처럼 인프라 담당자가 없는 환경에 적합. WAL 모드에서 다중 읽기 + 단일 쓰기 직렬화를 제공해, 오히려 결제 같은 쓰기 경합 상황에서 추가적인 안전장치가 된다.
- Socket.IO는 WebSocket을 우선 사용하고 실패 시 long-polling으로 자동 폴백하며, 재연결/재구독을 라이브러리가 처리 — "네트워크 재연결 시 자동 동기화" 요구사항과 정확히 부합.
- 단일 Express 프로세스가 API + 정적 빌드 파일(React build)을 함께 서빙할 수 있어 배포 단위가 하나(프로세스 1개, 포트 1개)로 단순화됨 — nginx/Caddy 리버스 프록시로 HTTPS 종단만 얹으면 됨.
- 테스트: Vitest/Jest + Supertest로 API 통합 테스트, Prisma의 테스트용 SQLite 파일로 격리된 테스트 DB 구성이 쉬움.

**단점**
- SQLite는 매우 높은 동시 쓰기 부하에는 Postgres보다 불리하나, 학교 반 부스 규모(테이블 수 개~수십 개, 동시 사용자 수십 명)에서는 문제가 되지 않음. 필요 시 Prisma의 DB 커넥터만 Postgres로 교체 가능하도록 스키마를 표준 SQL 범위 내에서 작성.

### 후보 B — Next.js(App Router) + Prisma + Postgres/SQLite + API Routes

**장점**
- 프론트엔드 라우팅과 백엔드 API를 한 프레임워크로 통합, SSR로 초기 로딩 최적화 가능.

**단점**
- Next.js의 API Routes는 기본적으로 서버리스/요청-응답 모델에 최적화되어 있어 WebSocket 같은 상시 연결 서버를 붙이려면 별도 커스텀 서버(Node http 서버 래핑)가 필요해 오히려 구조가 복잡해짐.
- 학교 부스 배포 환경에서 Next.js의 빌드/런타임 특성(서버 컴포넌트, 캐싱 레이어)은 이번 프로젝트의 단순한 요구사항 대비 과한 추상화를 추가함.

### 후보 C — Django + Django Channels + PostgreSQL

**장점**
- Django ORM과 admin 화면을 활용하면 관리자 기능 일부를 빠르게 구현 가능. Channels로 WebSocket 지원.

**단점**
- 프론트(고객 모바일 UI, 직원 KDS/POS UI)의 인터랙션 밀도가 높아 결국 React 등 SPA가 필요한데, Django+DRF+React 조합은 언어가 둘로 나뉘어(Python/JS) 팀 컨텍스트 스위칭 비용이 증가.
- Channels(ASGI) 운영은 Node.js의 Socket.IO보다 학교 부스 환경에서 설정/트러블슈팅 난이도가 높음.

## 결정

**후보 A**를 채택한다.

- 백엔드: Node.js(LTS) + TypeScript + Express
- ORM/DB: Prisma + SQLite(기본, 파일 기반 — 백업 = 파일 복사). 스키마는 Postgres로도 이전 가능하도록 Prisma 표준 기능 범위 내에서 작성.
- 프론트엔드: React + TypeScript + Vite (고객/직원 화면을 역할별 라우트로 분리한 단일 SPA, 빌드 결과물을 Express가 정적 서빙)
- 실시간 통신: Socket.IO (세부 근거는 `docs/adr/0002-realtime-communication.md`)
- 인증: 서버 세션 기반(쿠키, `HttpOnly/Secure/SameSite`), 테이블 손님 접근은 별도의 opaque 토큰 기반 세션
- 테스트: Vitest(단위) + Supertest(API 통합) + Playwright(E2E, 모바일 뷰포트 에뮬레이션 포함)
- 배포: 단일 Node 프로세스(pm2 등으로 관리) + nginx/Caddy 리버스 프록시로 HTTPS 종단

## 이유 요약

1. 언어 통일(TS)로 학교 부스라는 짧은 개발 기간에 적합한 생산성 확보.
2. SQLite = 파일 기반 백업/복구가 극도로 단순 — "학교 부스에서 쉽게 배포/복구" 요구사항에 정면 부합.
3. Socket.IO의 자동 재연결/폴백이 "네트워크 불안정 환경에서의 안정성" 요구사항을 프레임워크 레벨에서 해결.
4. 단일 프로세스 배포로 운영 복잡도 최소화.

## 트레이드오프로 받아들이는 것

- 매우 큰 동시 접속(수백 명 이상) 환경에는 SQLite/단일 프로세스 구조가 한계가 있으나, 학교 반 부스 규모에는 충분하다. 향후 확장 시 Postgres 전환 및 프로세스 분리를 재검토한다(그때 새 ADR 작성).
