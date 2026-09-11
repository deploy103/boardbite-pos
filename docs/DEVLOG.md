# DEVLOG.md

> 모든 개발 에이전트가 작업 종료 전에 반드시 갱신한다.
> 최신 기록이 위쪽에 오도록 작성한다.

---

## 2026-09-12 00:40

**작업자/에이전트:** Claude (메인 개발 에이전트)

**이번 작업 목적:** Phase 7(안정화) 착수 — `docs/OPERATIONS.md` 작성, 그 과정에서 발견한 "백업 UI 없음" 격차와 백업 생성일자 버그 수정.

**구현 내용:**
- `docs/OPERATIONS.md` 전면 작성 — 서버 시작/종료, 로그인, 자리배정, QR 문제, POS/SERVING 사용법, 정산(부분/더치/상품별/할인), 결제취소, 강제CLOSE, 품절, 네트워크 장애, 마감, 백업, 다음날 초기화까지 학생이 그대로 따라 할 수 있는 문장으로 작성.
- OPERATIONS.md를 쓰다가 **백업 기능이 백엔드만 있고 관리자 화면에 UI가 없다**는 것을 발견 — `client/src/pages/admin/BackupsPanel.tsx` 신규 작성, `AdminHome.tsx`에 "백업" 탭 추가.
- 백업 목록 API를 실제로 curl로 확인하던 중 **버그 발견**: `listBackups()`가 `fs.Stats.birthtime`을 썼는데, 이 프로젝트가 실행되는 WSL의 `/mnt/c/...`(DrvFs) 환경에서는 `birthtime`이 지원되지 않아 항상 `1970-01-01`을 반환했다. 파일명 자체에 생성 시각이 인코딩되어 있으므로(`boardbite-<ISO>.db`) 그것을 파싱해 복원하도록 수정하고, 파싱 실패 시에만 `mtime`으로 대체하게 함. `admin-operations.test.ts`의 백업 테스트에 "생성일이 2000년 이후이고 현재 시각과 1분 이내"라는 회귀 검증을 추가.

**실행한 테스트:** `server/tests/admin-operations.test.ts` 재실행(13개 전부 통과, 백업 생성일자 검증 추가됨). **전체 스위트 13개 파일 / 90개 테스트 전부 통과.** 클라이언트 `tsc --noEmit` 클린, `npm run build` 성공. 실행 중인 dev 서버에 curl로 백업 생성/목록 조회 재확인.

**교훈**: 운영 문서를 실제로 작성해보는 과정에서 "문서에는 쓰여있지만 실제로는 없는 기능"과 "있지만 특정 환경(WSL/DrvFs)에서만 발생하는 버그"를 둘 다 발견했다 — 문서화 자체가 좋은 QA 수단이 될 수 있음을 확인.

**남은 문제**: 실기기 테스트, Playwright E2E는 여전히 미착수.

**다음 작업자가 가장 먼저 할 일**: `docs/HANDOFF.md` 참고.

**관련 커밋:** (이 작업 직후 커밋 예정)

---

## 2026-09-12 00:25

**작업자/에이전트:** Claude (메인 개발 에이전트)

**이번 작업 목적:** 이전 커밋에서 빠졌던 요구사항.md §13.5 "로그 삭제(관리자 전용, 삭제 동작 자체의 최소 감사 흔적 유지)" 기능 추가.

**구현 내용:**
- `server/src/services/auditLog.ts`에 `purgeAuditLogs(beforeDate, staffId)` 추가 — 삭제보다 먼저 `AUDIT_LOG_PURGE` 레코드를 기록한 뒤 대상 레코드를 삭제. `AUDIT_LOG_PURGE` 자신은 어떤 정리 요청으로도 삭제되지 않음.
- `verifyAuditLogChain()` 로직을 재설계 — 정리로 인해 체인 중간(두 정리 시점 사이)에 링크가 끊기는 경우까지 정상 처리하도록 "체인 진입점"(첫 레코드 또는 AUDIT_LOG_PURGE 레코드)만 이전 레코드와의 연결 검증을 면제. **첫 구현은 버그가 있었다** — logs[0]만 예외 처리했더니 두 번째 정리 이후에 생성된 일반 레코드가 세 번째 정리로 삭제되면서 중간 링크가 끊기는 케이스를 "변조"로 오탐(자동 테스트로 발견, 즉시 수정).
- `server/src/routes/admin.routes.ts`: `POST /audit-logs/purge`(body `{beforeDate, confirm:true}`), 검색 필터 확장(`actorId`, `targetId`, `since`, `until`), CSV 내보내기도 동일 필터 지원.
- `client/src/pages/AdminHome.tsx`의 `LogsPanel`에 기간/액션 검색, CSV 내보내기 링크, 정리 버튼(브라우저 confirm 2회로 이중 확인) 추가.
- `docs/SECURITY.md` §1.1 신설 — 정리 기능이 "완전한 append-only" 원칙과 상충하는 지점과, 받아들이는 트레이드오프(정리 직전 구간은 무결성 증명 불가)를 명시. `docs/ARCHITECTURE.md`의 "UPDATE/DELETE는 DB 권한에서 제거" 표현도 SQLite에는 해당 개념이 없다는 사실에 맞춰 "코드 컨벤션" 표현으로 정정.

**실행한 테스트:** `server/tests/audit-log-purge.test.ts` 신규 5개 테스트 작성(정리 동작, PURGE 레코드 보존, 정리 후 체인 정상판정, API 이중확인, 필터 검색). **전체 스위트 13개 파일 / 90개 테스트 전부 통과.** 서버/클라이언트 `tsc --noEmit` 클린, client build 성공.

**남은 문제:** 없음(이 작업 범위 내에서는).

**다음 작업자가 가장 먼저 할 일:** `docs/HANDOFF.md` 참고 — Phase 7(안정화)로 진행.

**관련 커밋:** (이 작업 직후 커밋 예정)

---

## 2026-09-12 00:10

**작업자/에이전트:** Claude (메인 개발 에이전트) + 병렬 서브에이전트 5개(2팀으로 순차 투입)

**이번 작업 목적:** Phase 4(SERVING) + Phase 5(결제/정산) 전체 구현, Phase 6(ADMIN 고도화)의 상당 부분(결제수단/운영설정/매출현황/결제내역/DB백업/CSV 내보내기)을 함께 진행. "하드코딩 없이, 컴포넌트를 충분히 분리하고, 실제 서비스 수준으로" 개발하라는 사용자 지시에 따라 진행.

**사전에 읽은 문서:** AGENTS.md, docs/ARCHITECTURE.md, docs/RESEARCH.md(Agent E), docs/DEVLOG.md 직전 기록, docs/HANDOFF.md

**작업 방식**: 백엔드(스키마/서비스/라우트/동시성 설계/자동테스트)는 메인 에이전트가 전부 직접 작성 — 돈이 걸린 로직이라 서브에이전트에 위임하지 않고 직접 검증했다. 백엔드 계약이 안정화된 뒤, 프론트엔드 UI 3영역(FRONT 정산화면/SERVING화면/ADMIN 확장)을 서로 겹치지 않는 파일 범위로 나눠 병렬 서브에이전트 3개에 위임했다.

### 백엔드(메인 에이전트 직접 구현)

**스키마 확장** (`server/prisma/schema.prisma`, 마이그레이션 `20260911132320_payments_settings`):
- `Table`에 `ordersLocked`/`paymentsLocked` 추가(테이블별 주문/결제 잠금 분리).
- `TableSession.status`에 `PAID_PENDING_SERVICE` 상태 추가(완납했지만 미서빙 주문이 남은 상태).
- `Payment`에 `tenderedAmount`/`changeAmount` 추가(현금 받은금액/거스름돈), `kind`에 `DISCOUNT` 추가.
- 신규 모델: `PaymentMethod`(결제수단, CASH/CARD/OTHER 기본 + ADMIN 커스텀 추가 가능), `OperationSettings`(싱글턴, 전체 주문/결제 킬스위치 + KDS 지연기준 + 서빙되돌리기 허용시간 — **"하드코딩 금지" 지시를 반영해 원래 클라이언트에 상수로 박아뒀던 KDS 임박/지연 기준(Phase 3에서 5분/10분 하드코딩)을 이 설정으로 이전**하고 `client/src/lib/useOperationSettings.ts`로 어디서든 읽게 만듦).

**동시성 설계 — `docs/adr/0005-sqlite-write-concurrency.md` 신규 작성**: `docs/RESEARCH.md` Agent E가 제안한 "SELECT ... FOR UPDATE"는 SQLite가 지원하지 않는다는 사실을 마이그레이션 중 재확인하고, 대신 Prisma 커넥션 풀을 `connection_limit=1`로 고정해 애플리케이션 레벨에서 모든 트랜잭션을 완전 직렬화하는 방식으로 결정. `.env.example`/`.env`/`server/tests/testDbPath.ts`의 `DATABASE_URL`에 전부 반영.

**서비스 계층**:
- `server/src/services/payment.ts`(신규) — 결제 생성(AMOUNT/ITEMS 모드), 할인, 취소(VOID/REFUND 자동 구분)의 핵심 엔진. 현금은 `tenderedAmount`만 받아 서버가 `applied=min(tendered,remaining)`/`change`를 계산. 상품별 결제는 `PaymentAllocation` 집계로 "이미 결제된 수량"을 매번 재검증.
- `server/src/services/billing.ts` 확장 — `computeBill()`에 `discountAmount`/`chargedAmount` 분리 계산 추가(할인은 미수금은 줄이지만 매출 집계에서는 제외), `computeItemPaymentStatus()`(항목별 결제 현황) 신규, 트랜잭션 클라이언트를 받을 수 있도록 시그니처 확장(`Db` 타입).
- `server/src/services/tableSession.ts` 확장 — `maybeAutoSettleTableSession()` 신규(완납+미서빙없음→CLOSE, 완납+미서빙있음→PAID_PENDING_SERVICE, 취소 등으로 미수금 재발생 시 ACTIVE로 복귀). `order.ts`의 `markServed`/`rejectOrder`/`cancelOrder`에서 이 함수를 호출하도록 연결.
- `server/src/services/splitEvenly.ts`(신규) — 더치페이 최대 나머지법 분배 알고리즘, 순수 함수로 분리.
- `server/src/services/settings.ts`, `reporting.ts`(매출 요약), `backup.ts`(SQLite 파일 스냅샷), `csv.ts`(신규) — ADMIN 고도화용.

**라우트**:
- `server/src/routes/serving.routes.ts`(신규, Phase 4): READY 목록/최근서빙완료, 서빙완료/되돌리기(시간창 정책), 직원호출 ack/done.
- `server/src/routes/front.routes.ts` 대폭 확장(Phase 5): `/checkout`(정산화면 종합 데이터), `/split-suggestion`, `/payments`(생성), `/discount`, `/payments/:id/void`, `/payment-methods`(읽기전용).
- `server/src/routes/admin.routes.ts` 확장(Phase 6 일부): 결제수단 CRUD, 결제 내역 검색, 매출 현황, 운영 설정 CRUD, DB 백업 생성/목록/다운로드, CSV 내보내기(매출/감사로그).
- `server/src/routes/customer.routes.ts`/`middleware/requireTableSession.ts` 수정 — `PAID_PENDING_SERVICE`/`SETTLING` 상태에서도 조회는 허용하되 신규 주문만 `requireOrderableSession`(전체 주문잠금/테이블 주문잠금/세션 상태를 모두 검사)으로 차단.
- `server/src/routes/auth.routes.ts`에 `GET /api/staff/settings` 추가(모든 로그인 사용자가 조회 가능, 민감정보 아님).

**발견하고 고친 버그**: `createPayment()`의 idempotency 사전조회가 트랜잭션 밖에서 이루어져, 동시에 동일 idempotencyKey로 두 요청이 들어오면 P2002 unique constraint 에러가 그대로 터지는 문제를 자동 동시성 테스트(`payment.test.ts`)로 발견 — `order.ts`의 기존 패턴과 동일하게 P2002를 캐치해 기존 레코드를 반환하도록 수정.

### 프론트엔드(병렬 서브에이전트 3개, 파일 범위 분리로 충돌 방지)

- **FRONT 정산화면** (`client/src/pages/front/`): `CheckoutPage.tsx` + `AmountPaymentPanel`/`DutchSplitPanel`/`ItemSplitPanel`/`PaymentMethodPicker`/`CashQuickAmount`/`PaymentHistoryList`/`VoidReasonModal`/`DiscountModal`/`types.ts`/`format.ts`로 세분화. `FrontHome.tsx`에 "정산" 버튼 추가.
- **SERVING 화면** (`client/src/pages/serving/`): `ServingHome.tsx` + `ReadyOrderCard`/`RecentlyServedCard`/`StaffCallPanel`/`util.ts`.
- **ADMIN 확장** (`client/src/pages/admin/`): `SettingsPanel`/`PaymentMethodsPanel`/`PaymentsPanel`/`RevenuePanel`(+ 공용 `shared.ts`), `AdminHome.tsx`에 탭 4개 추가 + 기존 `TablesPanel`에 잠금 토글 추가.

**설계 결정**: 부분결제/복합결제/더치페이/상품별결제를 API 하나(`POST .../payments`, `mode: AMOUNT|ITEMS`)로 통합. 더치페이는 별도 엔드포인트 없이 "제안 금액 계산"(`split-suggestion`)만 서버가 하고 실제 결제는 각자 AMOUNT 모드로 개별 실행 — `docs/RESEARCH.md` Agent E의 "계산 결과가 아니라 실제 결제 레코드가 진실"을 그대로 반영.

**실행한 테스트**:
- 신규 자동 테스트 파일 4개 추가: `payment.test.ts`(20개), `serving-flow.test.ts`(7개), `splitEvenly.test.ts`(6개), `admin-operations.test.ts`(13개).
- **`cd server && npx vitest run` — 12개 파일 / 85개 테스트 전부 통과.**
- 서버/클라이언트 `tsc --noEmit` 클린, `npm run build`(client, 103 모듈) 성공.
- 실행 중인 dev 서버에 대해 curl로 전체 E2E 수동 회귀: 테이블 오픈 → 주문 → POS 접수/조리/준비완료 → SERVING 서빙완료 → FRONT 현금부분결제+상품별결제+할인 적용 → 잔액 0 → PAID_PENDING_SERVICE 전환 확인 → 서빙완료 시 자동 CLOSE 확인 → ADMIN 매출현황/설정/결제수단 조회까지 실제 HTTP로 검증 완료.

**발견된 문제(전부 수정 완료)**:
1. 위의 결제 idempotency 동시성 버그.
2. `server/prisma/dev.db-journal`이 `.gitignore`에서 누락되어 있었음(`*.db`는 `.db`로 끝나는 파일만 매치, `-journal` 접미사는 별도 패턴 필요) — `.gitignore`에 `*.db-journal`/`*.db-wal`/`*.db-shm` 추가.
3. 로컬 dev DB에 이전 세션에서 강제종료된 프로세스가 남긴 미정리 journal 파일이 있어, 데이터 정합성 우려로 로컬 dev.db를 삭제 후 마이그레이션+시드+데모데이터로 재생성(운영 데이터 아님, 손실 없음).
4. WSL 환경에서 dev 서버(tsx watch/vite)가 파일 변경 감지 실패 또는 간헐적 프로세스 종료를 반복 — 매번 수동 재시작으로 대응. 프로세스 생존 확인은 `ps`/`ss` 조합으로, curl 실패 한 번만으로 죽었다고 단정하지 말 것(재확인 결과 몇 차례는 오탐).

**남은 문제**:
- Phase 6 나머지(사용자 관리 고도화는 이미 있음, 필요하면 결제수단 정렬순서 UI 등 세부 편의기능)는 후속.
- 매출 리포트의 `since` 필터는 시작일만 지원(종료일 없음) — 필요시 추가.
- Playwright E2E(브라우저 자동화)는 아직 미도입 — 지금까지는 Vitest+Supertest 통합테스트와 수동 curl 회귀로 대체.
- 실기기(iPhone/Android/iPad) 테스트 미실시.
- `npm audit` moderate 취약점(react-router-dom, express→qs) 보류 중.

**다음 작업자가 가장 먼저 할 일**:
1. 본 DEVLOG와 `docs/ARCHITECTURE.md` §5~§8, `docs/adr/0005-sqlite-write-concurrency.md`를 읽는다.
2. 브라우저로 직접 `/front/checkout/:id`, `/serving`, `/admin`의 새 탭들을 열어 시각적 디자인을 다듬는다(현재는 기능 중심 1차 구현).
3. Playwright E2E 도입 검토(`docs/TEST-PLAN.md` §3의 시나리오 A~J를 자동화).
4. Phase 7(안정화): 실기기 테스트, `docs/OPERATIONS.md` 작성.

**관련 커밋:** (이 작업 직후 커밋 예정)

## 2026-09-11 23:10

**작업자/에이전트:** Claude (메인 개발 에이전트) + 병렬 서브에이전트 2개

**이번 작업 목적:** Phase 3(주방/KDS) 구현. 동시에 서브에이전트로 (1) Phase 2 테스트 커버리지 보강, (2) 고객 화면 UI 디자인 폴리싱 진행.

**사전에 읽은 문서:** AGENTS.md, docs/ARCHITECTURE.md, docs/DEVLOG.md 직전 기록, docs/HANDOFF.md

**작업 방식(서브에이전트 병렬 사용):**
- 메인 에이전트가 직접 담당: `server/src/services/order.ts`(상태 전이), `server/src/routes/pos.routes.ts`(신규), `server/src/app.ts`, `client/src/pages/pos/*`(신규), `client/src/App.tsx` 라우트 연결, `client/src/lib/useStaffSocket.ts`/`useNow.ts`/`beep.ts`(신규), `server/prisma/seedDemo.ts`(데모 데이터), `server/tests/pos-flow.test.ts`.
- 서브에이전트 A(테스트 커버리지): `server/tests/{login-guard,billing,table-session,admin-authz}.test.ts` 신규 작성, `server/tests/helpers.ts`에 헬퍼 3개 추가. 지정된 금지 파일(pos.routes.ts/app.ts/order.ts/realtime.ts/socket.ts)은 건드리지 않음.
- 서브에이전트 B(고객 UI): `client/src/pages/customer/` 아래 컴포넌트 분리(BottomSheet/OptionSheet/CartSheet/OrderStatusTimeline/MenuSkeleton/types.ts), `CustomerApp.tsx` 전면 개선, `styles.css`에 새 클래스만 append. 서버 코드와 AdminHome/FrontHome/App.tsx는 건드리지 않음.
- 두 서브에이전트가 동시에 `npx vitest run`을 실행하며 공유 SQLite 테스트 DB(`server/prisma/test.db`)가 충돌(readonly/테이블 없음 오류)하는 것을 확인 — **알려진 인프라 한계**로 기록(아래 "발견된 문제" 참고).

**구현 내용(백엔드, Phase 3):**
- `order.ts`에 상태 머신 함수 추가: `acceptOrder/rejectOrder/startPreparing/markReady/markServed/revertServedToReady/cancelOrder` — 전부 `docs/ARCHITECTURE.md §5.3` 전이 규칙을 강제(`OrderStateError`, 409). 각 전이마다 감사 로그(`ORDER_ACCEPTED` 등, 요구사항.md §14 이벤트명 그대로 사용)와 `RealtimeEvent.OrderStatusChanged` emit.
- `listOrdersForKitchen()` — NEW/ACCEPTED/PREPARING/READY를 그룹화해 KDS 보드 형태로 반환. `searchOrderHistory()` — 상태/테이블번호로 이력 검색.
- `pos.routes.ts` 신규: 보드/이력 조회, 상태 전이 5종, POS 권한 범위의 품절 토글(`PATCH /menu-items/:id/sold-out`). 전부 `requireRole('POS')`(ADMIN 겸임 허용).
- `customer.routes.ts`에 직원 호출 엔드포인트 추가(`GET/POST /api/customer/staff-call`) — 서브에이전트 B가 "백엔드 엔드포인트가 없어 UI를 못 붙였다"고 보고한 것을 반영해 메인 에이전트가 마저 구현. 이미 PENDING/ACKED인 호출이 있으면 중복 생성하지 않음.

**구현 내용(프론트엔드, Phase 3 + 고객 UI 폴리싱):**
- `/pos`에 실제 KDS 화면 연결(기존 RoleStub 대체): 4컬럼 보드(신규/접수/조리중/준비완료), 경과시간 배지(5분 임박/10분 지연, 색상+텍스트 병행), 거부/취소 사유 선택 모달, 이력/취소/품절처리 탭, Socket.IO(`staff:pos` room) 실시간 갱신 + 신규 주문 알림음(음소거 토글, localStorage 저장).
- 고객 화면(`CustomerApp.tsx`) 전면 개선: 옵션 선택 바텀시트(필수 그룹 검증, 단일/다중 선택), 장바구니 확인 바텀시트(수량 변경/삭제/합계), 주문 상태 타임라인(단계별 텍스트+아이콘, 거부/취소는 별도 알림 패널), 로딩 스켈레톤, 품절 안내 문구, 44px 이상 터치영역, 해요체/긍정형 카피 전면 적용. Socket.IO로 주문 생성/상태변경/결제/테이블CLOSE 이벤트 구독 + 20초 폴링 안전망.
- 직원 호출 버튼을 고객 화면 상단에 추가(대기중에는 재호출 방지, 상태 문구 전환).
- `server/prisma/seedDemo.ts`: 로컬 브라우징 확인용 데모 데이터(카테고리 4개, 메뉴 9개, 옵션그룹 1개, 테이블 3개 — 빈자리/이용중/비활성).

**설계 결정:**
- KDS 지연 기준(5분 임박/10분 지연)은 우선 클라이언트 상수로 하드코딩. ADMIN 설정으로 옮기는 것은 후속 작업으로 남김(주석에 명시).
- READY 상태 주문은 취소 불가(요구사항 그대로), SERVED로 잘못 넘어간 건은 `revertServedToReady()`로 되돌릴 수 있게 서비스 함수는 미리 준비(SERVING 화면은 Phase 4에서 연결 예정).

**실행한 테스트:**
- `cd server && npx vitest run` — **8개 파일, 39개 테스트 전부 통과** (RBAC, 주문 생성/idempotency, POS 상태 전이 8종, 테이블 세션 엣지케이스, 로그인 brute-force, 정산 계산, 관리자 authz, 감사로그 해시체인).
- 서버/클라이언트 `tsc --noEmit` 클린, `npm run build`(client) 성공.
- 실행 중인 dev 서버에 대해 curl로 수동 회귀 확인: POS 로그인/보드조회/접수→조리시작→준비완료 정상 전이, 잘못된 순서 전이 409, 거부 사유 누락 400, FRONT 계정의 POS API 호출 403, 이력 검색.

**테스트 결과:** 전부 통과.

**발견된 문제:**
1. **WSL 파일시스템 감시 이슈**: `/mnt/c/...` 경로에서 `tsx watch`와 Vite dev 서버 모두 파일 저장 후 자동 재시작/HMR이 안 되는 경우가 관찰됨(inotify가 DrvFs 마운트에서 불안정). 코드 변경 후에는 dev 서버를 수동으로 재시작해서 반영을 확인해야 했다. 다음 작업자도 동일 증상을 겪을 수 있으니 참고.
2. **공유 SQLite 테스트 DB 동시성**: 두 `npx vitest run`을 동시에 실행하면 `globalSetup`이 서로의 `test.db`를 지우면서 "attempt to write a readonly database" 오류가 발생한다. 서브에이전트/사람이 동시에 테스트를 돌리지 않도록 주의(순차 실행 필요). 향후 프로세스별 고유 DB 파일명을 쓰도록 `testDbPath.ts`를 개선하는 것을 고려할 것.
3. 백그라운드로 띄운 dev 서버(특히 Vite)가 별다른 에러 로그 없이 간헐적으로 종료되는 현상 관찰(리소스 제약/OOM 추정). 운영 배포 시에는 pm2 등 프로세스 매니저로 자동 재시작을 구성해야 한다(README/OPERATIONS.md에 반영 필요, 아직 미반영).

**남은 문제:**
- Phase 4(SERVING) 미구현 — `/serving`은 여전히 스텁. `markServed`/`revertServedToReady` 서비스 함수는 준비되어 있으므로 라우트+화면만 연결하면 됨.
- Phase 5(결제/정산) 전체 미구현.
- KDS 지연 기준(5/10분)이 하드코딩됨 — ADMIN 설정 연동 필요.
- 직원 호출을 SERVING이 확인(ACK)/완료 처리하는 UI/API 없음(모델과 이벤트는 준비됨).

**다음 작업자가 가장 먼저 할 일:**
1. 본 DEVLOG를 읽고, dev 서버가 죽어있으면 재시작한다(`cd server && npx dotenv -e ../.env -- npx tsx watch src/index.ts`, `cd client && npx vite --host 0.0.0.0`).
2. Phase 4(SERVING) 구현: `server/src/routes/serving.routes.ts` 신설(READY 목록 조회, `markServed`/`revertServedToReady` 호출, 직원 호출 ACK/완료 처리), `client/src/pages/serving/ServingHome.tsx` 신설.
3. 서브에이전트를 다시 활용할 경우, 반드시 `server/prisma/test.db`를 공유하는 `vitest run`을 동시에 두 개 이상 돌리지 않도록 지시할 것(위 "발견된 문제" #2 참고).

**관련 커밋:** (이 작업 직후 커밋 예정)

## 2026-09-11 22:20

**작업자/에이전트:** Claude (메인 개발 에이전트)

**이번 작업 목적:** Phase 2(핵심 기반) 구현 — 인증/RBAC, 메뉴, 테이블 OPEN/CLOSE, 고객 테이블 세션, 주문 생성, 감사 로그.

**사전에 읽은 문서:** AGENTS.md, docs/ARCHITECTURE.md, docs/adr/0001~0004, docs/SECURITY.md, docs/DEVLOG.md 직전 기록

**조사/확인:**
- Prisma는 SQLite 커넥터에서 네이티브 enum을 지원하지 않음을 마이그레이션 시도 중 발견 → 상태값을 String 컬럼 + 애플리케이션 레벨 리터럴 유니온 타입(`server/src/types/domain.ts`)으로 전환.

**변경 파일(요약):**
- 루트: `package.json`(npm workspaces), `.env.example`(DATABASE_URL 기본값 추가)
- `server/`: Express 앱(`src/app.ts`, `src/index.ts`), Prisma 스키마/마이그레이션/시드, 인증(`src/auth/*`), 미들웨어(`requireRole`, `requireTableSession`, `csrf`), 서비스(`auditLog`, `tableToken`, `tableSession`, `order`, `billing`), 라우트(`auth`, `customer`, `front`, `admin`), 실시간(`realtime.ts`, `socket.ts`), 테스트(`tests/*` — Vitest+Supertest)
- `client/`: Vite+React+TS 스캐폴드, 디자인 토큰(`styles.css`), 페이지(`StaffLogin`, `AdminHome`, `FrontHome`, `RoleStub`, `CustomerApp`)
- `docs/ARCHITECTURE.md` §4를 실제 스키마(`server/prisma/schema.prisma`) 참조로 정리(문서-코드 drift 방지)

**구현 내용:**
- 부트스트랩 계정 시드(`server/prisma/seed.ts`) — 이미 존재하는 아이디는 덮어쓰지 않음(AGENTS.md §6.5).
- 직원 인증: bcrypt 해시, 로그인/역할변경 시 세션 재발급, 계정+IP 단위 로그인 실패 rate limit(`loginGuard.ts`), 서버 세션은 Prisma 기반 커스텀 store(`PrismaSessionStore`)에 저장.
- RBAC: `requireRole()` 미들웨어를 라우터 전체에 일괄 적용, ADMIN은 모든 역할 겸임.
- 테이블 토큰: `Table.publicSlug`(고정, QR/NFC) + `TableSession.token`(세션별 동적, CSPRNG 32byte) 2단 구조(0004 ADR 그대로 구현). `requireTableSession` 미들웨어가 매 요청 ACTIVE 세션 + OPEN 테이블을 재검증.
- 주문 생성: 클라이언트가 보낸 가격/옵션가는 전부 무시하고 서버가 DB 현재값으로 재계산. `(tableSessionId, clientKey)` 복합 idempotency key + DB UNIQUE 제약으로 더블탭/동시 요청 중복을 원자적으로 차단(P2002 캐치 후 기존 주문 반환).
- 감사 로그: append-only + SHA256 해시체인, 단일 프로세스 내 Promise 체인으로 append 순서를 직렬화해 체인 분기 방지.
- CSRF 대응: 상태변경 요청에 커스텀 헤더(`X-BoardBite-Client`) 요구.
- 실시간: 내부 EventEmitter(`realtime.ts`) → Socket.IO room 브로드캐스트(`socket.ts`) 분리, room은 `table:{id}` / `staff:{role}`.

**설계 결정:**
- SQLite + Prisma는 enum 미지원 → String 컬럼 + zod/TS 유니온 타입으로 대체(스키마 주석에 허용값 명시).
- `closeTable`은 트랜잭션의 갱신 결과를 반환하도록 구현(최초 구현에서 갱신 전 stale 객체를 반환하던 버그를 수동 curl 검증 중 발견해 즉시 수정).

**실행한 테스트:**
- 수동 curl 시나리오: 로그인/로그아웃, CSRF 헤더 누락 차단, 로그인 실패, RBAC 우회 시도(POS→admin, SERVING→front) 403, 테이블/메뉴 생성, FRONT 테이블 OPEN, 손님 진입/메뉴조회/주문생성, 더블탭 idempotency, 가격 조작 무시, 테이블 CLOSE 후 이전 세션 차단 및 재진입 차단, 감사 로그 해시체인 검증.
- 자동화(Vitest+Supertest, `server/tests/`): `rbac.test.ts`(5), `order-flow.test.ts`(5 — 가격 위조 무시/동시 더블탭 idempotency/품절 차단/CLOSED 차단/재오픈 후 이전 세션 무효화), `auditLog.test.ts`(2 — 정상 체인 검증, 변조 탐지). **12/12 통과.**
- 클라이언트: `tsc --noEmit` 통과, `vite build` 성공.

**테스트 결과:** 전부 통과.

**발견된 문제(모두 수정 완료):**
- Prisma+SQLite enum 미지원 → String 전환.
- `closeTable` 응답이 갱신 전 stale 세션 반환 → 트랜잭션 결과 반환으로 수정.

**남은 문제:**
- Payment/PaymentAllocation 모델은 스키마에만 존재하고 API/서비스 로직은 아직 없음(Phase 5 예정).
- POS(KDS)/SERVING 화면은 스텁 상태(Phase 3/4 예정).
- `npm audit`에서 react-router-dom/express(qs) 관련 moderate 취약점 발견 — major 버전 업그레이드가 필요해 이번 커밋에서는 보류(브레이킹 체인지 검토 필요).
- 고객/직원 UI는 기능 위주 1차 구현이며 `docs/RESEARCH.md` Agent C의 세부 디자인 토큰(타이포 스케일 전체, 바텀시트 컴포넌트 등)은 기본 수준만 적용됨 — 추후 폴리싱 필요.

**다음 작업자가 가장 먼저 할 일:**
1. 본 DEVLOG와 `server/prisma/schema.prisma`, `docs/ARCHITECTURE.md`를 읽는다.
2. Phase 3(주방/KDS)부터 진행: `/pos` 화면 실제 구현(신규/접수/조리중/준비완료 탭, 상태 전이 API `PATCH /api/staff/pos/orders/:id/...` 등), 경과시간/지연 표시, 알림음.
3. `npm audit` 취약점(react-router-dom v7, express의 qs) 업그레이드 여부를 사용자와 상의 후 처리.

**관련 커밋:** `4cec715`(Phase 2 구현), `de2bcb3`/`cac8086`(CI: Gitleaks + typecheck/test/build 워크플로 추가, GitHub Actions에서 통과 확인)

## 2026-09-11 21:40

**작업자/에이전트:** Claude (메인 개발 에이전트)

**이번 작업 목적:** Phase 0(조사) 완료 및 Phase 1(설계) 완료.

**사전에 읽은 문서:**
- AGENTS.md, 요구사항.md, docs/RESEARCH.md(직전 기록), docs/DEVLOG.md 직전 기록

**조사/확인:**
- 5개 서브에이전트를 병렬로 실행해 OKPOS(후불형 POS), 배민 주문접수/KDS, 모바일 UX·Toss 디자인 원칙, OWASP 기반 보안 위협, 분할결제 데이터 모델을 조사. 결과를 `docs/RESEARCH.md`에 출처/적용 여부/이유와 함께 병합(총 27개 자료 섹션 + 5개 종합 제안).

**변경 파일:**
- `docs/RESEARCH.md` — Phase 0 조사 전체 병합, 체크리스트 전부 완료 처리
- `docs/adr/0001-tech-stack.md` — Node.js/TS+Express+Prisma+SQLite+React(Vite)+Socket.IO 채택
- `docs/adr/0002-realtime-communication.md` — Socket.IO(WebSocket 우선, 폴백)+REST 재동기화 채택
- `docs/adr/0003-auth-session.md` — 직원 서버세션 vs 손님 테이블 토큰 분리 채택
- `docs/adr/0004-table-token.md` — `Table.publicSlug`(고정) + `TableSession.token`(동적) 2단 구조 설계
- `docs/ARCHITECTURE.md` — 전체 데이터 모델(Prisma 스키마 초안), 역할/권한표, 상태 머신(테이블/세션/주문/정산), API 계약 요약, 오류/복구 정책
- `docs/SECURITY.md` — 19개 위협 → 대응 매핑 표, 인증/데이터보호/헤더, 보안 테스트 체크리스트
- `docs/TEST-PLAN.md` — 테스트 전략, 필수 자동 테스트 대상표, E2E 시나리오 A~J, 동시성 테스트, 수동 기기 테스트 체크리스트

**구현 내용:** 코드 구현 없음(Phase 1 설계까지 완료, 요구사항의 "조사→설계→구현" 순서 준수).

**설계 결정:**
- DB는 SQLite(Prisma) 기본 채택 — 파일 기반 백업의 단순성이 학교 부스 운영에 적합하다고 판단(0001 ADR).
- 실시간은 Socket.IO를 1차 채널로, 재연결 시 REST 재조회를 이중 안전장치로 채택(0002 ADR).
- 손님 테이블 접근은 "물리 QR/NFC 고정 slug" + "세션별 동적 토큰" 2단 구조로 설계해, 운영 편의성(태그 재발급 불필요)과 보안 요구사항(세션 폐기 시 즉시 차단)을 동시에 만족(0004 ADR).
- 결제/정산은 append-only Payment+PaymentAllocation 구조로 설계, Order/OrderItem에 파생 상태 컬럼을 두지 않음(ARCHITECTURE.md §4).

**실행한 테스트:** 없음(아직 코드 없음).

**테스트 결과:** 해당 없음.

**발견된 문제:** 문서 작성 중 두 차례 UTF-8 인코딩 깨짐(mojibake) 발생 — 발견 즉시 수정 완료, 전체 docs/ 디렉터리 재검사로 추가 손상 없음 확인.

**남은 문제:**
- Phase 2(핵심 기반: 인증/역할/메뉴/테이블/OPEN-CLOSE/고객 세션/주문 생성/감사 로그) 이후 전부 미구현.
- 실제 프로젝트 스캐폴딩(package.json, Prisma 스키마 파일, Express 앱 구조 등) 아직 생성 안 됨.

**다음 작업자가 가장 먼저 할 일:**
1. 본 DEVLOG와 `docs/ARCHITECTURE.md`, `docs/adr/`를 읽는다.
2. `AGENTS.md` §5 Phase 2 순서대로 프로젝트 스캐폴딩(Node/TS/Express/Prisma/React 초기 세팅)부터 시작한다.
3. Prisma 스키마를 `docs/ARCHITECTURE.md` §4 초안 기준으로 실제 `schema.prisma`로 옮기고 마이그레이션을 생성한다.
4. 인증(부트스트랩 계정 시드, 세션 로그인, 역할별 리다이렉트)부터 구현한다.

**관련 커밋:** (이 작업 직후 커밋 예정)

## 2026-09-11 20:56

**작업자/에이전트:** Claude (메인 개발 에이전트)

**이번 작업 목적:** 프로젝트 착수 — GitHub 저장소 생성, 문서/디렉터리 뼈대 구성, Phase 0(조사) 착수.

**사전에 읽은 문서:**
- 개발프롬프트.md
- AGENTS.md
- 요구사항.md
- DEVLOG.template.md / RESEARCH.template.md

**조사/확인:**
- 현재 디렉터리는 git 저장소가 아니었음. GitHub에 `boardbite-pos` 저장소가 없음을 확인.
- gh CLI 인증 상태: `deploy103` 계정으로 로그인 되어 있음.
- Node v24.15.0, npm 11.12.1 사용 가능 확인.

**변경 파일:**
- `.git` 초기화, origin 원격 연결 (`git@github.com:deploy103/boardbite-pos.git`)
- `.gitignore`, `.env.example`, `LICENSE`(MIT), `README.md` 신규 작성
- `docs/RESEARCH.md`(템플릿 복사), `docs/DEVLOG.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TEST-PLAN.md`, `docs/OPERATIONS.md`, `docs/HANDOFF.md`, `docs/adr/` 생성

**구현 내용:** 코드 구현 없음. 저장소/문서 뼈대만 구성 (요구사항에 따라 Phase 0 전 코딩 금지).

**설계 결정:** 없음 (기술 스택은 Phase 0 조사 이후 ADR로 결정 예정).

**실행한 테스트:** 없음.

**테스트 결과:** 해당 없음.

**발견된 문제:** 없음.

**남은 문제:**
- Phase 0 조사(OKPOS/배민·KDS/UX·UI/보안/데이터·정산 모델)가 진행 중이며 `docs/RESEARCH.md`에 병합 필요.
- 기술 스택 ADR(`docs/adr/0001-tech-stack.md`) 및 실시간 통신 방식 ADR 미작성.

**다음 작업자가 가장 먼저 할 일:**
1. 본 DEVLOG와 `docs/RESEARCH.md`를 읽는다.
2. Phase 0 조사가 완료되지 않았다면 이어서 진행한다.
3. 조사 완료 후 `docs/adr/0001-tech-stack.md`와 실시간 통신 ADR을 작성한 뒤 Phase 1(설계)로 진행한다.

**관련 커밋:** (이 작업 직후 커밋 예정)
