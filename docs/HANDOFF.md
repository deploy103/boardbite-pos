# HANDOFF.md

> 다른 에이전트/개발자가 이 문서만 읽고 이어받을 수 있도록 최신 상태를 유지한다.

## 현재 단계

Phase 4(SERVING) + Phase 5(결제/정산) 구현 완료, Phase 6(ADMIN 고도화) 대부분 완료. 남은 것은 Phase 7(안정화)과 UI 디자인 폴리싱. (2026-09-12)

## 로컬 실행 방법

```bash
npm install
cp .env.example .env   # 값 채우기 (SESSION_SECRET, ADMINID/... 등)
npm run prisma:migrate --workspace server   # 최초 1회: 마이그레이션 + 시드 자동 실행
npm run dev:server      # http://localhost:3000
npm run dev:client      # http://localhost:5173 (API/소켓은 3000으로 프록시)
```

**주의**: `.env`의 `DATABASE_URL`은 반드시 `?connection_limit=1` 쿼리 파라미터를 포함해야 한다(예: `file:./dev.db?connection_limit=1`). 이는 결제 동시성 제어의 핵심 전제다(`docs/adr/0005-sqlite-write-concurrency.md`).

프로덕션 유사 실행: `npm run build:client && npm run build:server && npm run --workspace server start` (client/dist를 서버가 정적 서빙).

테스트: `cd server && npx vitest run` (격리된 SQLite 테스트 DB 자동 생성/정리, 12개 파일/85개 테스트 전부 통과).

로컬 브라우징용 데모 데이터: `cd server && npx dotenv -e ../.env -- npx tsx prisma/seedDemo.ts` (테이블 3개 + 메뉴 + 옵션 + 진행 중인 주문 1건 생성).

## 지금까지 완료된 것

- GitHub 저장소 `boardbite-pos`(https://github.com/deploy103/boardbite-pos), Phase 0 조사(`docs/RESEARCH.md`), Phase 1 설계(ADR 0001~0005, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TEST-PLAN.md`).
- **Phase 2 핵심 기반**: 인증, RBAC, 테이블 2단 토큰, 손님 세션 검증, 메뉴 CRUD, 주문 생성(서버측 가격재계산+idempotency), 해시체인 감사로그.
- **Phase 3 주방/KDS**: 주문 상태 머신(`order.ts`), POS 화면(4컬럼 보드, 경과시간 배지, 사유 모달, 이력/품절 탭), 고객 화면(옵션/장바구니 바텀시트, 상태 타임라인, 직원호출).
- **Phase 4 SERVING (신규 완료)**:
  - `server/src/routes/serving.routes.ts`: READY 목록/최근서빙완료, 서빙완료/되돌리기(시간창 정책, `settings.servedRevertWindowSeconds`), 직원호출 ack/done.
  - `client/src/pages/serving/`: `ServingHome.tsx` + `ReadyOrderCard`/`RecentlyServedCard`/`StaffCallPanel`.
- **Phase 5 결제/정산 (신규 완료, 가장 큰 작업)**:
  - `server/src/services/payment.ts`: 부분/복합/더치/상품별 결제를 `POST /table-sessions/:id/payments`(mode: AMOUNT|ITEMS) 하나로 통합. 현금 받은금액/거스름돈 자동계산, 비현금 초과결제 차단, 상품별 결제는 이미 결제된 수량 재검증.
  - 할인(`kind=DISCOUNT`), 결제취소(VOID/REFUND 자동 구분, append-only).
  - 완납 자동 처리: `maybeAutoSettleTableSession()` — 미서빙 없으면 즉시 CLOSE, 있으면 `PAID_PENDING_SERVICE`(신규 주문만 차단, 조회는 허용) 후 서빙 완료 시 자동 CLOSE.
  - **동시성**: `docs/adr/0005-sqlite-write-concurrency.md` — SQLite는 `SELECT FOR UPDATE` 미지원이라 Prisma `connection_limit=1`로 애플리케이션 레벨 완전 직렬화. 실제 동시 결제 테스트로 검증됨.
  - `client/src/pages/front/CheckoutPage.tsx` + 8개 하위 컴포넌트: 금액/더치페이/상품별 결제 탭, 결제 내역+취소, 할인 모달.
- **Phase 6 ADMIN 고도화 (대부분 완료)**:
  - 결제수단 관리(`PaymentMethod`, CASH/CARD/OTHER + 커스텀 추가), 운영 설정(`OperationSettings` 싱글턴 — 전체 주문/결제 킬스위치, KDS 지연기준, 서빙되돌리기 허용시간), 테이블별 주문/결제 잠금(`Table.ordersLocked/paymentsLocked`), 결제 내역 검색, 매출 현황 대시보드, DB 백업(생성/목록/다운로드), CSV 내보내기(매출/감사로그).
  - `client/src/pages/admin/`: `SettingsPanel`/`PaymentMethodsPanel`/`PaymentsPanel`/`RevenuePanel`.
  - **"하드코딩 금지" 원칙 적용**: KDS 지연 기준은 더 이상 클라이언트 상수가 아니라 `OperationSettings`에서 읽는다(`client/src/lib/useOperationSettings.ts`).
- **테스트**: 서버 12개 파일 / 85개 테스트 전부 통과(`payment.test.ts` 20개가 결제 동시성/현금/상품별/할인/취소/자동정산을 전부 커버). 서버·클라이언트 `tsc --noEmit` 클린, `npm run build`(client) 성공. 실행 중인 dev 서버로 전체 흐름(주문→조리→서빙→정산→자동CLOSE) curl E2E 검증 완료.

## 아직 안 된 것

- **Phase 7(안정화)**: 실기기(iPhone Safari/Android Chrome/iPad) 테스트 미실시. Playwright E2E 브라우저 자동화 미도입(현재는 Vitest+Supertest 통합테스트 + 수동 curl 회귀로 대체). `docs/OPERATIONS.md`는 아직 스켈레톤 상태 — 실제 화면이 다 나온 지금이 작성 적기.
- UI 디자인 폴리싱: FRONT/SERVING/ADMIN 신규 화면은 기능 중심 1차 구현. 실제 브라우저로 열어서 레이아웃/터치영역/카피를 다듬는 패스가 필요.
- 매출 리포트 `since` 필터는 시작일만 지원(종료일 없음).
- `npm audit` moderate 취약점(react-router-dom, express→qs) — major 업그레이드 검토 보류 중.
- **인프라 주의사항**:
  1. WSL(`/mnt/c/...`) 환경에서 `tsx watch`/Vite dev 서버가 파일 저장만으로 반영되지 않거나 간헐적으로 종료되는 현상이 있다. 코드 변경 후 반영 안 되면 수동 재시작. **죽었는지 확인할 때는 curl 실패 한 번만으로 판단하지 말고 `ps -ef | grep <프로세스>`와 `ss -ltnp | grep <포트>`로 재확인할 것**(오탐 경험 있음).
  2. `npx vitest run`을 동시에 두 개 이상 돌리면 공유 SQLite 테스트 DB(`server/prisma/test.db`)가 충돌한다(순차 실행할 것).
  3. `.gitignore`의 `*.db-journal`/`*.db-wal`/`*.db-shm` 누락을 발견해 추가함 — 혹시 이전 커밋에 실수로 journal 파일이 들어간 적 없는지 `git log --all --full-history -- '*.db-journal'`로 한 번 확인해볼 것(현재 세션에서는 없었음을 확인함).

## 다음 작업자가 가장 먼저 할 일

1. `docs/DEVLOG.md` 최신 항목을 읽는다. dev 서버가 죽어있으면 재시작한다.
2. 브라우저로 `/front/checkout/:id`, `/serving`, `/admin`의 새 화면들을 직접 열어보고 디자인을 다듬는다(요구사항.md §15, docs/RESEARCH.md Agent C 원칙 참고).
3. Playwright 도입 검토 — `docs/TEST-PLAN.md` §3의 시나리오 A~J를 실제 브라우저로 자동화.
4. Phase 7: 실기기 테스트, `docs/OPERATIONS.md` 작성(이제 실제 화면 기준으로 쓸 수 있음).

## 알려진 blocker

없음.
