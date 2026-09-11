# ARCHITECTURE.md

> Phase 1(설계) 산출물. `docs/RESEARCH.md`와 `docs/adr/`의 결정을 바탕으로 작성한다.
> 현재는 스켈레톤 상태이며 Phase 0 조사 완료 후 채운다.

## 1. 개요

(작성 예정 — 시스템 구성도, 배포 토폴로지)

## 2. 기술 스택

(작성 예정 — `docs/adr/0001-tech-stack.md` 참고)

## 3. 역할/권한표

(작성 예정 — CUSTOMER / FRONT / POS / SERVING / ADMIN)

## 4. 데이터 모델

(작성 예정 — User, Table, TableSession, MenuItem, Option, Order, OrderItem, Payment, PaymentAllocation, AuditLog 등)

## 5. 상태 머신

### 5.1 테이블 상태
(작성 예정 — DISABLED / AVAILABLE / OPEN / SETTLING)

### 5.2 주문 상태
(작성 예정 — NEW / ACCEPTED / PREPARING / READY / SERVED / REJECTED / CANCELLED)

### 5.3 결제/정산
(작성 예정)

## 6. API 계약

(작성 예정)

## 7. 실시간 통신

(작성 예정 — `docs/adr/` 참고)

## 8. 오류/복구 정책

(작성 예정 — 네트워크 재연결, idempotency, 재시도)
