# DEVLOG.md

> 모든 개발 에이전트가 작업 종료 전에 반드시 갱신한다.
> 최신 기록이 위쪽에 오도록 작성한다.

---

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

**관련 커밋:** (이 작업 직후 커밋 예정)

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
