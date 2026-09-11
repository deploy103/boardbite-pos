# HANDOFF.md

> 다른 에이전트/개발자가 이 문서만 읽고 이어받을 수 있도록 최신 상태를 유지한다.

## 현재 단계

Phase 2(핵심 기반) 구현 완료, Phase 3(주방/KDS) 착수 대기 (2026-09-11)

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
- **Phase 2 핵심 기반 구현 완료:**
  - 인증: 부트스트랩 계정 시드, bcrypt, 세션 재발급, 로그인 rate limit, 역할별 리다이렉트(`server/src/routes/auth.routes.ts`)
  - RBAC: `requireRole()` 미들웨어, ADMIN 겸임 허용
  - 테이블: `Table.publicSlug` + `TableSession.token` 2단 토큰(0004 ADR 구현), OPEN/CLOSE, 이용시간 연장(`server/src/services/tableSession.ts`)
  - 손님 세션: `requireTableSession` 미들웨어, 매 요청 ACTIVE+OPEN 재검증
  - 메뉴: 카테고리/아이템/옵션 CRUD(ADMIN), 품절/가격변경 감사로그
  - 주문 생성: 서버측 가격 재계산, idempotency key로 중복 차단(`server/src/services/order.ts`)
  - 감사 로그: append-only + 해시체인(`server/src/services/auditLog.ts`)
  - 실시간 골격: EventEmitter → Socket.IO room(`server/src/socket.ts`) — 아직 클라이언트에서 소켓 구독은 미연결(REST 폴링만 사용 중)
  - 클라이언트: 로그인/ADMIN/FRONT/고객 주문 화면 1차 구현(디자인 폴리싱은 미완)
  - 테스트: Vitest+Supertest 12개 자동 테스트(RBAC 우회, 가격 위조, 더블탭 동시성, 품절, CLOSED 차단, 세션 재사용 차단, 감사로그 변조 탐지) 전부 통과

## 아직 안 된 것

- Phase 3(주방/KDS): `/pos` 화면 실제 구현, 주문 상태 전이 API(접수/거부/조리시작/완료), 경과시간/지연 표시, 알림음, 이력 검색
- Phase 4(SERVING): READY 목록, 서빙완료, 되돌리기, 직원 호출 처리
- Phase 5(결제/정산): Payment/PaymentAllocation은 스키마만 존재, API/동시성 제어 로직 없음 — 부분/복합/더치/상품별 결제 전부 미구현
- Phase 6(ADMIN 고도화): 매출 대시보드, CSV 내보내기, 백업/복구, 결제 잠금 등
- Phase 7(안정화): 실기기 테스트, 부하 테스트, 운영 매뉴얼(`docs/OPERATIONS.md`) 작성
- 클라이언트 소켓 구독(현재는 15초 폴링으로만 FRONT 화면 갱신) — Socket.IO 클라이언트 연결 및 room join 로직 미구현
- `npm audit` moderate 취약점(react-router-dom, express→qs) — major 업그레이드 필요, 보류 중

## 다음 작업자가 가장 먼저 할 일

1. `docs/DEVLOG.md` 최신 항목을 읽는다.
2. Phase 3(주방/KDS) 진행: `server/src/routes/pos.routes.ts` 신설(주문 상태 전이 API), 감사 로그 이벤트(`ORDER_ACCEPTED` 등) 추가, `RealtimeEvent.OrderStatusChanged` emit 연결.
3. 클라이언트 `client/src/pages/RoleStub.tsx`(POS) 자리에 실제 KDS 화면 구현, `socket.io-client`로 `staff:pos` room 구독.
4. Phase 5 착수 시 `docs/RESEARCH.md` Agent E의 동시성 제어(비관적 락 + 조건부 UPDATE) 설계를 그대로 구현에 반영할 것.

## 알려진 blocker

없음.
