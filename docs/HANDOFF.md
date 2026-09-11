# HANDOFF.md

> 다른 에이전트/개발자가 이 문서만 읽고 이어받을 수 있도록 최신 상태를 유지한다.

## 현재 단계

Phase 3(주방/KDS) 구현 완료, Phase 4(SERVING) 착수 대기 (2026-09-11)

## 로컬 실행 방법

```bash
npm install
cp .env.example .env   # 값 채우기 (SESSION_SECRET 등)
npm run prisma:migrate --workspace server   # 최초 1회: 마이그레이션 + 시드 자동 실행
npm run dev:server      # http://localhost:3000
npm run dev:client      # http://localhost:5173 (API/소켓은 3000으로 프록시)
```

프로덕션 유사 실행: `npm run build:client && npm run build:server && npm run --workspace server start` (client/dist를 서버가 정적 서빙).

테스트: `cd server && npx vitest run` (격리된 SQLite 테스트 DB 자동 생성/정리).

## 지금까지 완료된 것

- GitHub 저장소 `boardbite-pos`(https://github.com/deploy103/boardbite-pos), Phase 0 조사(`docs/RESEARCH.md`), Phase 1 설계(ADR 0001~0004, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TEST-PLAN.md`) — 이전 기록 참고.
- **Phase 2 핵심 기반**: 인증(부트스트랩 시드/bcrypt/세션재발급/로그인rate limit), RBAC(`requireRole()`), 테이블 2단 토큰(publicSlug+TableSession.token), 손님 세션 검증, 메뉴 CRUD, 주문 생성(서버측 가격재계산+idempotency), 해시체인 감사로그.
- **Phase 3 주방/KDS 구현 완료:**
  - 주문 상태 머신(`server/src/services/order.ts`): accept/reject/startPreparing/markReady/markServed/revertServedToReady/cancelOrder — 전부 상태 전이 검증+감사로그+실시간 emit
  - `server/src/routes/pos.routes.ts`: 보드 조회(상태별 그룹화), 이력/취소 검색, 5개 전이 액션, 품절 토글
  - `client/src/pages/pos/`: 실제 KDS 화면(4컬럼 보드, 경과시간 배지, 거부/취소 사유 모달, 이력/품절 탭, 소켓 실시간 갱신 + 알림음)
  - 고객 화면(`client/src/pages/customer/`) 전면 개선: 옵션 선택/장바구니 바텀시트, 주문 상태 타임라인, 로딩 스켈레톤, 직원 호출 버튼(`GET/POST /api/customer/staff-call` 신규)
  - 소켓 클라이언트 연결 완료(`client/src/lib/useStaffSocket.ts`, 고객 화면도 직접 연결) — REST 폴링은 안전망으로 유지
  - 테스트: Vitest+Supertest **8개 파일 39개 전부 통과** (RBAC, 주문생성/idempotency, POS 상태전이 8종, 테이블세션 엣지케이스, 로그인 brute-force, 정산계산, 관리자 authz, 감사로그)
  - 로컬 브라우징용 데모 데이터 스크립트: `server/prisma/seedDemo.ts`

## 아직 안 된 것

- Phase 4(SERVING): READY 목록 화면, `markServed`/`revertServedToReady` 연결(서비스 함수는 이미 존재), 직원 호출 ACK/완료 처리 API/화면
- Phase 5(결제/정산): Payment/PaymentAllocation은 스키마만 존재 — 부분/복합/더치/상품별 결제, 동시성 제어(비관적 락) 전부 미구현
- Phase 6(ADMIN 고도화): 매출 대시보드, CSV 내보내기, 백업/복구, 결제 잠금
- Phase 7(안정화): 실기기 테스트, 부하 테스트, 운영 매뉴얼(`docs/OPERATIONS.md`)
- KDS 지연 기준(5분/10분)이 `client/src/pages/pos/OrderCard.tsx`에 하드코딩됨 — ADMIN 설정 연동 필요
- `npm audit` moderate 취약점(react-router-dom, express→qs) — major 업그레이드 필요, 보류 중
- **인프라 주의사항**: `/mnt/c/...` 경로의 WSL 환경에서는 `tsx watch`/Vite dev 서버의 자동 재시작(HMR)이 파일 저장만으로 반영되지 않는 경우가 있었다. 코드 변경 후 화면에 반영이 안 되면 dev 서버를 수동 재시작할 것. 또한 서브에이전트 등으로 `npx vitest run`을 동시에 두 개 이상 돌리면 공유 SQLite 테스트 DB(`server/prisma/test.db`)가 충돌하니 순차 실행할 것.

## 다음 작업자가 가장 먼저 할 일

1. `docs/DEVLOG.md` 최신 항목을 읽는다. dev 서버가 죽어있으면 재시작한다: `cd server && npx dotenv -e ../.env -- npx tsx watch src/index.ts`, `cd client && npx vite --host 0.0.0.0`.
2. Phase 4(SERVING) 구현: `server/src/routes/serving.routes.ts` 신설 — READY 주문 조회, `markServed`/`revertServedToReady` 호출 엔드포인트, `StaffCallRequest` 조회/ACK/완료 처리. `client/src/pages/serving/ServingHome.tsx` 신설(현재 `RoleStub`을 대체).
3. Phase 5 착수 시 `docs/RESEARCH.md` Agent E의 동시성 제어(비관적 락 + 조건부 UPDATE) 설계를 그대로 구현에 반영할 것.

## 알려진 blocker

없음.
