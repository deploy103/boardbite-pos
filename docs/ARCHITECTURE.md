# ARCHITECTURE.md

> Phase 1(설계) 산출물. `docs/RESEARCH.md`와 `docs/adr/`의 결정을 바탕으로 작성한다.

## 1. 개요

BoardBite POS는 단일 Node.js(TypeScript) 프로세스가 다음을 함께 제공한다(`docs/adr/0001-tech-stack.md`).

```text
┌─────────────────────────────────────────────────────────┐
│                Node.js(Express) 프로세스                  │
│                                                           │
│  REST API  ── Prisma ──  SQLite(파일 DB)                 │
│  Socket.IO(WebSocket, room 기반)                          │
│  React(Vite) 빌드 정적 파일 서빙                           │
└─────────────────────────────────────────────────────────┘
        ▲                     ▲                    ▲
        │ HTTPS(리버스 프록시)  │                    │
   손님 모바일 브라우저     FRONT/POS/SERVING/ADMIN(태블릿/PC)
   (/t/{public_slug})      (/staff/login → 역할별 라우트)
```

- 리버스 프록시(nginx/Caddy)가 HTTPS 종단을 담당하고 내부적으로 Node 프로세스(HTTP)로 전달한다.
- 실시간 갱신은 Socket.IO room 기반으로 처리하되, 재연결 시 항상 REST로 전체 상태를 재조회한다(`docs/adr/0002-realtime-communication.md`).

## 2. 기술 스택

`docs/adr/0001-tech-stack.md` 참고. 요약: Node.js + TypeScript + Express + Prisma + SQLite + React(Vite) + Socket.IO.

## 3. 역할/권한표

| 기능 영역 | CUSTOMER | FRONT | POS | SERVING | ADMIN |
|---|---|---|---|---|---|
| 테이블 세션(토큰) 조회/주문 | O(자기 세션만) | - | - | - | - |
| 테이블 배정/OPEN/CLOSE | X | O | X | X | O |
| 이용시간 연장 | X | O | X | X | O |
| 주문 생성 | O(자기 세션만) | X | X | X | X |
| 주문 접수/거부/조리상태 변경 | X | X | O | X | O |
| 서빙 완료 처리 | X | X | X | O | O |
| 결제/정산(부분/복합/더치/상품별) | X | O | X | X | O |
| 결제 취소/정정 | X | O(사유 필수) | X | X | O |
| 메뉴/옵션/가격/품절 관리 | X | X | X(품절만 허용 범위) | X | O |
| 직원 계정 관리 | X | X | X | X | O |
| 감사 로그 조회/정리 | X | X | X | X | O |
| 매출/운영 현황 | X | 부분(테이블 현황) | X | X | O |

모든 검사는 서버 미들웨어에서 강제하며, 프론트엔드의 화면 숨김은 보조 수단일 뿐이다(`docs/RESEARCH.md` Agent D — BFLA 대응).

## 4. 데이터 모델

`docs/RESEARCH.md` Agent E(결제 데이터 모델)와 `docs/adr/0004-table-token.md`(테이블 세션)를 결합해 설계했다.

실제 스키마 정의(단일 진실 공급원)는 `server/prisma/schema.prisma`에 있다. SQLite 커넥터는 Prisma의 네이티브 enum을
지원하지 않으므로, 상태값(Role/TableStatus/TableSessionStatus/OrderStatus/PaymentKind 등)은 String 컬럼 +
`server/src/types/domain.ts`의 리터럴 유니온 타입 및 각 라우트의 zod 스키마로 검증한다.

핵심 엔티티: `StaffUser`, `StaffSession`(세션 스토어), `LoginAttempt`(brute-force 방지), `Table`, `TableSession`,
`GameTimePlan`/`TableGameUsage`, `MenuCategory`/`MenuItem`/`OptionGroup`/`OptionChoice`, `Order`/`OrderItem`/`OrderItemOption`,
`Payment`/`PaymentAllocation`, `PaymentMethod`, `OperationSettings`(싱글턴), `AuditLog`, `StaffCallRequest`.

**핵심 설계 결정(연구 근거 반영)**

- `Order`/`OrderItem`에 `paidAmount`/`isPaid` 컬럼을 두지 않는다. 미수금은 항상 `Payment`+`PaymentAllocation`을 집계해 파생한다(`docs/RESEARCH.md` Agent E, `server/src/services/billing.ts`).
- `Payment`는 append-only. 취소는 `kind='VOID'`(세션이 아직 ACTIVE/PAID_PENDING_SERVICE일 때, 즉시 취소) 또는 `'REFUND'`(세션이 이미 CLOSED/EXPIRED일 때, 사후 환불)인 새 레코드를 추가해 원본을 상쇄한다. `kind='DISCOUNT'`도 존재하며 미수금 계산에는 `CHARGE`와 동일하게 반영되지만 매출 집계(`chargedAmount`)에서는 제외된다. UPDATE/DELETE는 애플리케이션 DB 계정 권한에서 제거한다.
- 모든 금액 필드는 KRW 정수(SQLite INTEGER). 부동소수점 금지.
- `Payment.tenderedAmount`/`changeAmount`는 현금(`PaymentMethod.isCash=true`) 결제에서만 채워지며, "받은 금액/거스름돈"을 그대로 영수증에 재현할 수 있게 한다.
- `AuditLog`는 해시체인으로 사후 변조를 탐지 가능하게 한다(`docs/RESEARCH.md` Agent D).
- 메뉴/옵션 가격은 주문 시점에 `OrderItem.unitPrice`/`OrderItemOption.extraPriceSnapshot`으로 스냅샷하여, 이후 관리자가 가격을 바꿔도 기존 주문 금액이 바뀌지 않는다.
- **하드코딩 금지 원칙**: KDS 지연 기준, 서빙 되돌리기 허용 시간, 전체 주문/결제 활성화 여부는 전부 `OperationSettings` 싱글턴 행에서 읽어온다(`server/src/services/settings.ts`). 클라이언트는 `GET /api/staff/settings`로 이 값을 가져와 사용하며 상수로 박아두지 않는다(`client/src/lib/useOperationSettings.ts`).
- 결제수단은 `PaymentMethod` 테이블로 관리되며 ADMIN이 CASH/CARD/OTHER 외 커스텀 결제수단을 추가할 수 있다. `isCash=true`인 결제수단만 받은금액/거스름돈 로직이 적용된다(커스텀 결제수단은 항상 `isCash=false`로 생성되어 실물 현금 거스름돈 개념이 섞이지 않는다).
- 테이블 단위 운영 잠금은 `Table.ordersLocked`(주문만 잠금)와 `Table.paymentsLocked`(정산만 잠금)로 분리되어 있어, 예를 들어 주방이 밀렸을 때 주문만 잠그고 이미 나간 음식의 정산은 계속 받을 수 있다.

## 5. 상태 머신

### 5.1 테이블 상태 (`Table.status`)

```text
DISABLED ⇄ AVAILABLE → OPEN → SETTLING → AVAILABLE
```

- `AVAILABLE`: 손님 없음, 주문 불가.
- `OPEN`: FRONT가 배정, 고객 주문 가능(현재 `TableSession.status=ACTIVE`인 세션 존재).
- `SETTLING`: 정산 진행 중이거나 완납 후 잔여 서비스 처리 중.
- 완납 + 잔여 서비스 없음 → 자동으로 `AVAILABLE`로 복귀, 해당 `TableSession.status=CLOSED`.

### 5.2 테이블 세션 상태 (`TableSession.status`)

```text
ACTIVE → PAID_PENDING_SERVICE → CLOSED (완납, 미서빙 주문 있음 → 서빙 완료 시 자동 CLOSE)
ACTIVE → CLOSED (완납 + 미서빙 주문 없음, 또는 FRONT 강제 종료)
PAID_PENDING_SERVICE → ACTIVE (결제 취소 등으로 다시 미수금이 발생하면 되돌아감)
ACTIVE|PAID_PENDING_SERVICE → EXPIRED (관리자 토큰 회전 등 예외 무효화)
```

- `PAID_PENDING_SERVICE`: 완납되었지만 아직 조리/서빙 중인 주문이 남아 있는 상태(`server/src/services/tableSession.ts`의 `maybeAutoSettleTableSession()`). 이 상태에서는 신규 주문만 차단되고, 손님은 여전히 주문 현황/청구서/직원호출을 볼 수 있다(`requireTableSession`은 통과, `requireOrderableSession`만 차단). `Table.status`도 함께 `SETTLING`으로 전환된다.
- CLOSED/EXPIRED 세션의 토큰으로 오는 모든 API 요청은 403 + 안내 메시지를 반환한다.
- `maybeAutoSettleTableSession()`은 결제 생성 직후(`payment.ts`)와 주문이 SERVED/REJECTED/CANCELLED로 바뀔 때(`order.ts`)마다 호출되어, "미수금 0 + 미서빙 주문 0"이 되는 즉시 CLOSED로 전환한다.

### 5.3 주문 상태 (`Order.status`)

```text
NEW → ACCEPTED → PREPARING → READY → SERVED
NEW → REJECTED
NEW|ACCEPTED|PREPARING → CANCELLED
```

- READY(조리완료)와 SERVED(서빙완료)를 분리해 진행요원의 서빙 누락을 방지한다(`docs/RESEARCH.md` Agent B).
- 이미 결제된 항목이 포함된 주문의 취소는 단순 상태변경으로 끝나지 않고, 해당 `OrderItem`에 연결된 `PaymentAllocation`이 있으면 "환불 필요" 플래그를 정산 화면에 노출한다.

### 5.4 결제/정산

```text
totalAmount   = Σ(OrderItem.unitPrice × quantity + 옵션 추가금, 취소되지 않은 주문의 항목)
chargedAmount = Σ(CHARGE) − Σ(원본이 CHARGE인 VOID/REFUND)
discountAmount= Σ(DISCOUNT) − Σ(원본이 DISCOUNT인 VOID/REFUND)
paidAmount    = chargedAmount + discountAmount
remaining     = totalAmount − paidAmount   (음수면 초과 수납 = 환불 필요, 별도 플래그 없이 이 값 자체가 신호)

remaining == 0 이고 미서빙 주문이 없음 → 자동 CLOSE (TableSession.status=CLOSED, Table.status=AVAILABLE)
remaining == 0 이지만 미서빙 주문이 있음 → TableSession.status=PAID_PENDING_SERVICE, Table.status=SETTLING, 신규 주문만 차단
```

`server/src/services/billing.ts`의 `computeBill()`이 이 계산을 담당하며, 트랜잭션 클라이언트를 받을 수 있게 설계되어 있다(아래 §8 동시성 정책 참고). 결제 생성/취소/할인 로직은 `server/src/services/payment.ts`에 있다.

**부분/복합/더치/상품별 결제를 하나의 API로 통합**한 설계(`POST /api/staff/front/table-sessions/:id/payments`):

- `mode: "AMOUNT"` — 금액 지정 결제. 부분결제(남은 금액 일부만), 복합결제(여러 번 다른 수단으로 반복 호출)가 전부 이 모드의 반복 호출로 표현된다. 현금(`PaymentMethod.isCash=true`)은 `tenderedAmount`(받은 금액)만 받아 서버가 `applied = min(tendered, remaining)`, `change = tendered - applied`를 계산한다. 비현금은 `amount`를 직접 받되 `remaining`을 초과할 수 없다.
- `mode: "ITEMS"` — 상품별 분할결제. `allocations: [{orderItemId, quantity}]`만 받고 금액은 서버가 계산한다. 각 `OrderItem`의 "이미 결제된 수량"을 `PaymentAllocation`으로 재계산해 초과 결제를 차단한다(`computeItemPaymentStatus()`).
- N명 더치페이는 별도 API 없이 `GET .../split-suggestion?people=N`(최대 나머지법으로 인원수만큼 나눈 금액 배열 반환)로 제안 금액만 계산해주고, 실제 결제는 각 인원이 `mode: "AMOUNT"`로 개별 실행한다(`docs/RESEARCH.md` Agent E — "계산 결과가 아니라 실제 결제 레코드가 진실").
- 할인은 별도 엔드포인트(`POST .../discount`)로 `kind='DISCOUNT'` Payment를 만든다 — 미수금 계산에는 CHARGE와 동일하게 반영되지만 매출 집계에서는 제외된다.
- 결제 취소는 `POST /api/staff/front/payments/:id/void`로, 원본을 지우지 않고 VOID/REFUND 레코드를 추가한다.

## 6. API 계약 (요약)

전체 스펙은 각 라우트 파일(`server/src/routes/*.routes.ts`)의 zod 스키마가 실질적인 단일 진실 공급원이다. 여기서는 핵심 원칙과 엔드포인트 지도를 기록한다.

- 손님 API: `Authorization`이 아니라 `TableSession` 쿠키(`boardbite_table_token`)로 인가. 모든 경로는 `/api/customer/*`.
- 직원 API: 세션 쿠키 + 역할 미들웨어. `/api/staff/front/*`(FRONT), `/api/staff/pos/*`(POS), `/api/staff/serving/*`(SERVING). 모든 역할 라우터는 ADMIN 겸임을 허용한다(`requireRole()`).
- 관리자 API: `/api/staff/admin/*`, `requireRole('ADMIN')` 미들웨어 일괄 적용.
- 공통 직원 API: `GET /api/staff/settings` — 로그인한 어떤 역할이든 조회 가능(운영 설정은 민감정보가 아니므로 역할 제한 없음). 값을 바꾸는 `PATCH /api/staff/admin/settings`는 ADMIN 전용.

### 손님 (`/api/customer`)
| 메서드/경로 | 설명 |
|---|---|
| `GET /entry/:slug` | `Table.publicSlug` 진입점. OPEN/SETTLING 테이블이면 세션 쿠키 발급 |
| `GET /menu` | 판매 중인 메뉴/옵션 조회 |
| `GET /session` | 테이블 번호, 세션 상태, 청구서(`bill`) |
| `GET /orders` | 이 세션의 주문 목록/상태 |
| `POST /orders` | 주문 생성. body `{ idempotencyKey, items:[{menuItemId, quantity, optionChoiceIds[]}], note? }`. `requireOrderableSession`으로 ACTIVE + 잠금없음 + 전체주문활성 재검증 |
| `GET/POST /staff-call` | 직원 호출 조회/생성(중복 방지) |

### 주방 POS (`/api/staff/pos`)
| 메서드/경로 | 설명 |
|---|---|
| `GET /board` | 활성 주문을 NEW/ACCEPTED/PREPARING/READY로 그룹화 |
| `GET /history` | 이력/취소 검색(`status`, `tableNumber`, `limit`) |
| `POST /orders/:id/accept` \| `/start-preparing` \| `/ready` | 상태 전이 |
| `POST /orders/:id/reject` \| `/cancel` | body `{reason}` 필수 |
| `GET /menu-items` | POS 관점 메뉴 목록(품절 토글용) |
| `PATCH /menu-items/:id/sold-out` | body `{isSoldOut}` |

### 서빙 (`/api/staff/serving`)
| 메서드/경로 | 설명 |
|---|---|
| `GET /ready` | READY 주문 목록(`readyAt` 오름차순) |
| `GET /recently-served` | 최근 SERVED 30건 |
| `POST /orders/:id/served` | READY → SERVED |
| `POST /orders/:id/revert` | SERVED → READY. `settings.servedRevertWindowSeconds` 경과 시 ADMIN 외에는 403 |
| `GET /staff-calls` | PENDING/ACKED 호출 목록 |
| `POST /staff-calls/:id/ack` \| `/done` | 호출 확인/완료 처리 |

### 프론트 정산 (`/api/staff/front`)
| 메서드/경로 | 설명 |
|---|---|
| `GET /tables` | 테이블 그리드(상태/세션/청구서/잠금 여부) |
| `POST /tables/:id/open` \| `/close` | 테이블 OPEN/CLOSE |
| `POST /table-sessions/:id/extend-game` | 이용시간 연장 |
| `GET /table-sessions/:id/orders` | 해당 세션 주문 목록 |
| `GET /table-sessions/:id/checkout` | 정산 화면 종합 데이터(청구서 + 항목별 결제상태 + 결제이력) |
| `GET /table-sessions/:id/split-suggestion?people=N` | 더치페이 제안 금액(최대 나머지법) |
| `POST /table-sessions/:id/payments` | 결제 생성(§5.4 참고) |
| `POST /table-sessions/:id/discount` | 할인 적용 |
| `POST /payments/:id/void` | 결제 취소/환불 |
| `GET /payment-methods` | 활성 결제수단 목록(읽기 전용) |
| `GET /game-plans` | 활성 이용권 목록(읽기 전용) |

### 관리자 (`/api/staff/admin`)
사용자/테이블/메뉴/이용권/감사로그(기존)에 더해: `PATCH /tables/:id`에 `ordersLocked`/`paymentsLocked` 추가, `GET/POST /payment-methods`+`PATCH /payment-methods/:id`(결제수단 관리, CASH는 비활성화 불가), `GET /payments`(전체 결제 검색), `GET /revenue`(매출 요약), `GET/PATCH /settings`(운영 설정), `GET/POST /backups` + `GET /backups/:filename`(DB 백업 생성/목록/다운로드), `GET /export/revenue.csv` + `GET /export/audit-logs.csv`(CSV 내보내기).

## 7. 실시간 통신

`docs/adr/0002-realtime-communication.md` 참고. Room: `table:{tableSessionId}`, `staff:pos`, `staff:serving`, `staff:front`, `staff:admin`.

## 8. 오류/복구 정책

- **Idempotency**: 주문 생성/결제 생성/할인 생성은 클라이언트 생성 키(`idempotencyKey`)를 요구하고 DB UNIQUE 제약으로 원자적 중복 차단(`docs/RESEARCH.md` Agent D). 사전 조회(빠른 실패)와 실제 insert 사이의 경합은 `P2002` 캐치 후 기존 레코드를 반환하는 방식으로 이중 방어한다(`server/src/services/order.ts`, `payment.ts`).
- **재연결**: 소켓 재연결 시 클라이언트는 항상 REST로 현재 상태를 재조회. 소켓 이벤트는 트리거일 뿐 신뢰의 근원이 아니다.
- **동시 결제/동시 쓰기 전반**: PostgreSQL의 `SELECT ... FOR UPDATE` 대신, SQLite 특성에 맞춘 별도 전략을 쓴다 — **`docs/adr/0005-sqlite-write-concurrency.md` 참고.** 요약하면 Prisma 커넥션 풀을 1개로 고정(`connection_limit=1`)해 모든 트랜잭션을 애플리케이션 레벨에서 직렬화하고, 잔액/이미 결제된 수량 재검증은 항상 트랜잭션 내부에서 최신 값으로 다시 계산한다.
- **서버 재시작 내구성**: 메뉴/테이블/직원 계정/주문/결제/결제수단/운영설정/감사로그/현재 테이블 세션은 모두 SQLite에 영속화되어 재시작 후에도 유지된다.
- **DB 백업**: ADMIN이 `/admin` 운영설정 화면에서 언제든 SQLite 파일 스냅샷을 생성할 수 있다(`server/src/services/backup.ts`). 파일 복사 방식이므로 트래픽이 적은 시점(마감 직후 등)에 실행할 것을 권장한다(`docs/OPERATIONS.md` 참고).
