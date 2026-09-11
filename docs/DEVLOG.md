# DEVLOG.md

> 모든 개발 에이전트가 작업 종료 전에 반드시 갱신한다.
> 최신 기록이 위쪽에 오도록 작성한다.

---

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
