# DEVLOG.md

> 모든 개발 에이전트가 작업 종료 전에 반드시 갱신한다.
> 최신 기록이 위쪽에 오도록 작성한다.

---

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
