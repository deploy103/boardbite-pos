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

`docs/RESEARCH.md` Agent E(결제 데이터 모델)와 `docs/adr/0004-table-token.md`(테이블 세션)를 결합한 전체 스키마.

```prisma
model StaffUser {
  id                String   @id @default(cuid())
  username          String   @unique
  passwordHash      String
  displayName       String
  role              Role     // ADMIN | FRONT | POS | SERVING
  isActive          Boolean  @default(true)
  mustResetPassword Boolean  @default(false)
  isBootstrap       Boolean  @default(false) // .env 기반 부트스트랩 계정 여부
  lastLoginAt       DateTime?
  createdAt         DateTime @default(now())
}

model Table {
  id         String       @id @default(cuid())
  number     Int          @unique   // 표시용 "7번 테이블" — 인가에 사용하지 않음
  name       String?
  status     TableStatus  @default(AVAILABLE) // DISABLED | AVAILABLE | OPEN | SETTLING
  publicSlug String       @unique   // QR/NFC 물리 태그에 인코딩되는 고정 토큰
  sortOrder  Int          @default(0)
}

model TableSession {
  id            String            @id @default(cuid())
  tableId       String
  token         String            @unique // 세션 쿠키가 가리키는 내부 식별자(서명/해시 저장)
  status        TableSessionStatus @default(ACTIVE) // ACTIVE | CLOSED | EXPIRED
  guestCount    Int?
  note          String?
  openedById    String
  openedAt      DateTime          @default(now())
  closedAt      DateTime?
  closeReason   String?           // NORMAL | FORCE_CLOSED | ...
}

model GameTimePlan {
  id       String  @id @default(cuid())
  name     String  // "20분"
  minutes  Int
  price    Int     // KRW 정수
  isActive Boolean @default(true)
}

model TableGameUsage {
  id             String   @id @default(cuid())
  tableSessionId String
  planId         String
  minutes        Int      // 스냅샷(요금제 변경에 영향받지 않도록)
  price          Int      // 스냅샷
  startedAt      DateTime @default(now())
  endsAt         DateTime // 연장 시 새 row를 추가(연장 이력 보존)
}

model MenuCategory {
  id        String @id @default(cuid())
  name      String
  sortOrder Int    @default(0)
}

model MenuItem {
  id            String   @id @default(cuid())
  categoryId    String
  name          String
  description   String?
  price         Int      // KRW 정수
  imageUrl      String?
  isActive      Boolean  @default(true)   // 판매 여부
  isSoldOut     Boolean  @default(false)
  needsCooking  Boolean  @default(true)
  showInKitchen Boolean  @default(true)
  sortOrder     Int      @default(0)
}

model OptionGroup {
  id          String  @id @default(cuid())
  menuItemId  String
  name        String  // "곱빼기"
  required    Boolean @default(false)
  multiSelect Boolean @default(false)
}

model OptionChoice {
  id         String @id @default(cuid())
  groupId    String
  name       String
  extraPrice Int    @default(0) // KRW 정수
}

model Order {
  id             String      @id @default(cuid())
  tableSessionId String
  status         OrderStatus @default(NEW) // NEW|ACCEPTED|PREPARING|READY|SERVED|REJECTED|CANCELLED
  idempotencyKey String      @unique        // (tableSessionId, clientKey) 조합을 해시
  note           String?                    // 고객 요청사항
  rejectReason   String?
  cancelReason   String?
  createdAt      DateTime    @default(now())
  acceptedAt     DateTime?
  preparingAt    DateTime?
  readyAt        DateTime?
  servedAt       DateTime?
  cancelledAt    DateTime?
}

model OrderItem {
  id           String  @id @default(cuid())
  orderId      String
  menuItemId   String
  nameSnapshot String  // 주문 시점 메뉴명 스냅샷
  unitPrice    Int     // 주문 시점 단가 스냅샷(KRW)
  quantity     Int
}

model OrderItemOption {
  id                String @id @default(cuid())
  orderItemId       String
  nameSnapshot      String
  extraPriceSnapshot Int   // KRW
}

model Payment {
  id                 String      @id @default(cuid())
  tableSessionId     String      // 정산은 테이블 세션 단위(여러 Order를 포괄)
  kind               PaymentKind // CHARGE | VOID | REFUND
  method             String      // CASH | CARD | OTHER | (ADMIN 정의 확장)
  amount             Int         // KRW, 항상 양수
  payerLabel         String?     // 정산 UI 표시용(더치페이 "1번 손님" 등)
  reversedPaymentId  String?     // VOID/REFUND가 가리키는 원본 CHARGE
  reason             String?     // VOID/REFUND 사유
  idempotencyKey     String      @unique
  createdById        String      // 처리한 StaffUser
  createdAt          DateTime    @default(now())
}

model PaymentAllocation {
  id          String @id @default(cuid())
  paymentId   String
  orderItemId String
  quantity    Int    // 이 결제가 커버하는 수량
  amount      Int    // KRW
}

model AuditLog {
  id         String   @id @default(cuid())
  actorType  String   // STAFF | SYSTEM
  actorId    String?
  action     String   // ORDER_CREATED, PAYMENT_VOIDED, ... (요구사항.md §14 목록)
  targetType String?
  targetId   String?
  metadata   String?  // JSON string (민감정보 제외)
  prevHash   String   // 직전 로그 레코드 해시(체인)
  hash       String   // SHA256(prevHash + 본 레코드 payload)
  createdAt  DateTime @default(now())
}

model StaffCallRequest {
  id             String   @id @default(cuid())
  tableSessionId String
  status         String   @default("PENDING") // PENDING | ACKED | DONE
  createdAt      DateTime @default(now())
  ackedAt        DateTime?
  doneAt         DateTime?
}
```

**핵심 설계 결정(연구 근거 반영)**

- `Order`/`OrderItem`에 `paidAmount`/`isPaid` 컬럼을 두지 않는다. 미수금은 항상 `Payment`+`PaymentAllocation`을 집계해 파생한다(`docs/RESEARCH.md` Agent E).
- `Payment`는 append-only. 취소는 `kind='VOID'`(즉시) 또는 `'REFUND'`(사후)인 새 레코드를 추가해 원본을 상쇄한다. UPDATE/DELETE는 애플리케이션 DB 계정 권한에서 제거한다.
- 모든 금액 필드는 KRW 정수(SQLite INTEGER). 부동소수점 금지.
- `AuditLog`는 해시체인으로 사후 변조를 탐지 가능하게 한다(`docs/RESEARCH.md` Agent D).
- 메뉴/옵션 가격은 주문 시점에 `OrderItem.unitPrice`/`OrderItemOption.extraPriceSnapshot`으로 스냅샷하여, 이후 관리자가 가격을 바꿔도 기존 주문 금액이 바뀌지 않는다.

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
ACTIVE → CLOSED (정상 완납 또는 강제 종료)
ACTIVE → EXPIRED (관리자 토큰 회전 등 예외 무효화)
```

CLOSED/EXPIRED 세션의 토큰으로 오는 모든 API 요청은 403 + 안내 메시지를 반환한다.

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
remaining = Σ(OrderItem.unitPrice × quantity, 취소되지 않은 항목)
          − Σ(CHARGE 금액)
          + Σ(VOID/REFUND로 상쇄된 금액)

remaining == 0 이고 미서빙 주문이 없음 → 자동 CLOSE
remaining == 0 이지만 미서빙 주문이 있음 → 내부 상태 PAID_PENDING_SERVICE로 표시, FRONT에 경고, 신규 주문만 차단
```

## 6. API 계약 (요약)

전체 스펙은 구현 단계에서 OpenAPI로 구체화한다. 여기서는 핵심 원칙만 기록한다.

- 손님 API: `Authorization`이 아니라 `TableSession` 쿠키로 인가. 모든 경로는 `/api/customer/*`.
- 직원 API: 세션 쿠키 + 역할 미들웨어. `/api/staff/front/*`, `/api/staff/pos/*`, `/api/staff/serving/*`.
- 관리자 API: `/api/admin/*`, `requireRole('ADMIN')` 미들웨어 일괄 적용.
- 주문 생성(`POST /api/customer/orders`): body는 `{ idempotencyKey, items: [{ menuItemId, quantity, optionChoiceIds[] }], note? }`만 받는다. 가격/합계/테이블 식별자는 서버가 계산.
- 결제 생성(`POST /api/staff/front/table-sessions/:id/payments`): body는 `{ idempotencyKey, method, amount, allocations?: [{orderItemId, quantity}], payerLabel? }`.

## 7. 실시간 통신

`docs/adr/0002-realtime-communication.md` 참고. Room: `table:{tableSessionId}`, `staff:pos`, `staff:serving`, `staff:front`, `staff:admin`.

## 8. 오류/복구 정책

- **Idempotency**: 주문 생성/결제 생성은 클라이언트 생성 키(`Idempotency-Key`)를 요구하고 DB UNIQUE 제약으로 원자적 중복 차단(`docs/RESEARCH.md` Agent D).
- **재연결**: 소켓 재연결 시 클라이언트는 항상 REST로 현재 상태를 재조회. 소켓 이벤트는 트리거일 뿐 신뢰의 근원이 아니다.
- **동시 결제**: `SELECT ... FOR UPDATE` + 조건부 UPDATE로 초과결제를 DB 레벨에서 차단(`docs/RESEARCH.md` Agent E).
- **서버 재시작 내구성**: 메뉴/테이블/직원 계정/주문/결제/감사로그/현재 테이블 세션은 모두 SQLite에 영속화되어 재시작 후에도 유지된다.
