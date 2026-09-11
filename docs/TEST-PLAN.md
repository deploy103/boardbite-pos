# TEST-PLAN.md

> Phase 1 산출물. `docs/adr/0001-tech-stack.md`에 따라 Vitest(단위) + Supertest(API 통합) + Playwright(E2E)를 사용한다.

## 1. 테스트 전략

- **단위 테스트**: 순수 로직(더치페이 나머지 분배 알고리즘, 미수금 계산, 상태 전이 검증 함수 등) — Vitest.
- **통합 테스트**: API 엔드포인트를 실제 SQLite 테스트 DB(요청마다 격리된 파일 또는 트랜잭션 롤백)로 검증 — Vitest + Supertest.
- **E2E 테스트**: 실제 브라우저로 화면 흐름 검증(모바일 뷰포트 포함) — Playwright.
- **동시성 테스트**: Node 프로세스 내에서 Promise.all로 동시 요청을 발사해 race condition을 재현 — Vitest + Supertest.

## 2. 필수 자동 테스트 대상

| 대상 | 테스트 유형 | 근거 | 상태 |
|---|---|---|---|
| RBAC 우회 방지 (POS→admin API, SERVING→결제 API) | 통합 | `docs/SECURITY.md` §1 | ✅ `rbac.test.ts`, `pos-flow.test.ts`, `serving-flow.test.ts` |
| 테이블 OPEN/CLOSE, CLOSED 주문 차단 | 통합 | `요구사항.md` §4.4 | ✅ `table-session.test.ts`, `order-flow.test.ts` |
| 가격/수량 위변조 무시 | 통합 | `docs/SECURITY.md` §1 | ✅ `order-flow.test.ts` |
| 주문 idempotency(중복 방지) | 통합 + 동시성 | `docs/ARCHITECTURE.md` §8 | ✅ `order-flow.test.ts` |
| 주문 상태 전이(허용/불허 전이) | 단위 | `docs/ARCHITECTURE.md` §5.3 | ✅ `pos-flow.test.ts` |
| 미수금 계산(Payment/PaymentAllocation 집계) | 단위 | `docs/RESEARCH.md` Agent E | ✅ `billing.test.ts` |
| 현금 거스름돈 계산 | 단위 | `요구사항.md` §12.2 | ✅ `payment.test.ts` |
| 부분/복합/더치/상품별 결제 | 통합 | `요구사항.md` §12.3~12.6 | ✅ `payment.test.ts`(부분/상품별/할인), `splitEvenly.test.ts`(더치 배분 로직) |
| 동일 상품 수량 일부 결제 | 통합 | `docs/ARCHITECTURE.md` §4 | ✅ `payment.test.ts` |
| 초과결제 차단 | 통합 + 동시성 | `docs/SECURITY.md` §1 | ✅ `payment.test.ts` |
| 결제 취소/환불 및 감사 로그 | 통합 | `요구사항.md` §12.8 | ✅ `payment.test.ts` |
| 자동 CLOSE, 이전 고객 세션 폐기 | 통합 | `요구사항.md` §4.4, §12.9 | ✅ `payment.test.ts`(PAID_PENDING_SERVICE 포함), `order-flow.test.ts` |
| 사용자 역할 변경 | 통합 | `요구사항.md` §13.1 | ✅ `admin-authz.test.ts` |
| 동시 결제(레이스 컨디션) | 동시성 | `docs/RESEARCH.md` Agent E, `docs/adr/0005` | ✅ `payment.test.ts` |
| 감사 로그 해시체인 무결성 | 단위 | `docs/SECURITY.md` §1 | ✅ `auditLog.test.ts` |
| 더치페이 나머지(원 단위) 정확 분배 | 단위 | `docs/RESEARCH.md` Agent E | ✅ `splitEvenly.test.ts` |
| 로그인 brute force(계정/IP) | 통합 | `docs/SECURITY.md` §1 | ✅ `login-guard.test.ts` |
| 운영 설정 킬스위치/테이블 잠금 | 통합 | `요구사항.md` §19 | ✅ `admin-operations.test.ts` |
| 서빙완료 되돌리기 시간 제한 | 통합 | `요구사항.md` §2.4 | ✅ `serving-flow.test.ts` |
| DB 백업 생성/다운로드/경로조작 방지 | 통합 | `요구사항.md` §13 | ✅ `admin-operations.test.ts` |
| 감사 로그 정리(purge) 및 정리 후 해시체인 정상 판정 | 통합 | `요구사항.md` §13.5 | ✅ `audit-log-purge.test.ts` |

**서버 자동 테스트 현황(2026-09-12 기준): 13개 파일 / 90개 테스트, 전부 통과.** `cd server && npx vitest run`으로 재현.

## 3. E2E 시나리오 (Playwright, `요구사항.md` §21 기준)

- 시나리오 A(정상 흐름): FRONT OPEN → 고객 주문 → POS 접수/조리/완료 → SERVING 완료 → 추가주문 → FRONT 정산(현금) → 잔액 0 → 자동 CLOSE → 재주문 실패.
- 시나리오 B(다른 테이블 추측): slug/세션 변조 시도 → 실패.
- 시나리오 C(가격 위조): 요청 body 가격 변조 → 서버 가격 적용 확인.
- 시나리오 D(더블탭): 주문 버튼 빠르게 2회 클릭 → 1건만 생성.
- 시나리오 E(분할결제): 30,000원을 3명이 서로 다른 수단으로 분할 → 합계 정확히 30,000원.
- 시나리오 F(상품별 결제): 동일 상품 2개 중 1개만 결제 → 나머지 1개 미결제로 남음.
- 시나리오 G(동시 정산): 두 FRONT 세션이 동시 결제 시도 → 초과결제 없음.
- 시나리오 H(권한 우회): POS 계정으로 관리자 API 호출 → 403.
- 시나리오 I(CLOSED 주문): CLOSED 테이블 QR 접근 → 차단 안내.
- 시나리오 J(결제 후 세션): 완납 후 이전 고객 브라우저에서 주문 시도 → 세션 만료 오류.

## 4. 동시성 테스트 상세

- 두 주문 동시 제출(같은 테이블, 다른 idempotency key) → 둘 다 생성.
- 같은 주문 중복 제출(동일 idempotency key) → 1건만 생성, 응답은 기존 주문 반환.
- 두 FRONT가 동시에 결제(`Promise.all`로 동시 발사) → 합계가 총액을 초과하지 않음.
- 같은 상품 수량을 동시에 부분결제(예: 수량 2에 대해 두 요청이 동시에 quantity=1씩 결제) → 정확히 2개까지만 성공, 3번째는 거부.

## 5. 수동/기기 테스트 체크리스트

- [ ] iPhone Safari: 고객 화면 레이아웃/safe-area/터치 영역
- [ ] Android Chrome: 고객 화면 호환성
- [ ] iPad/태블릿: FRONT 화면 조작성
- [ ] KDS 화면 장시간 표시(메모리 누수, 시간 표시 갱신) 확인
- [ ] 여러 테이블 동시 주문 시 KDS/SERVING 반영
- [ ] 여러 기기에서 같은 테이블 접근(정상적으로 같은 상태 공유되는지)
- [ ] Wi-Fi 재연결 시 자동 동기화
- [ ] 서버 재시작 후 데이터 보존 확인
