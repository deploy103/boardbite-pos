# 0004 — 테이블 공개 토큰(QR/NFC) 설계

- 상태: 채택됨
- 날짜: 2026-09-11
- 관련 문서: `docs/SECURITY.md`, `docs/RESEARCH.md` (Agent D — IDOR/BOLA, Agent A — OKPOS/NFC-QR 비교)

## 배경

`요구사항.md` §4.3과 `AGENTS.md` §6.1은 `/table/7`, `?table=3` 같은 순차 식별자 노출을 명시적으로 금지한다. QR/NFC로 접근하는 손님용 URL은 추측 불가능해야 하며, 서버는 토큰만 신뢰하지 않고 매 요청마다 테이블/세션 상태를 재검증해야 한다(`docs/RESEARCH.md` Agent D의 BOLA 대응 원칙).

## 결정

### 데이터 모델

```text
Table
- id (내부 PK, 절대 클라이언트에 노출하지 않음)
- number (사람이 보는 "7번 테이블" 표시용, 이것만으로 인가하지 않음)
- status: DISABLED | AVAILABLE | OPEN | SETTLING
- public_slug (선택, 관리자 QR 인쇄용 — 이것도 추측 불가 토큰)

TableSession (테이블 OPEN마다 새로 생성)
- id
- table_id (FK)
- token (32바이트 이상 CSPRNG, base62 인코딩, URL-safe)
- status: ACTIVE | CLOSED | EXPIRED
- opened_at, closed_at
- opened_by (FK -> StaffUser)
```

- QR/NFC에 인코딩되는 URL은 `Table.id`가 아니라 **현재 `TableSession.token`**을 가리킨다. 즉 토큰은 테이블이 아니라 "이번 이용 세션"에 발급된다.
- 테이블이 CLOSE되면 해당 `TableSession.status = CLOSED`로 전환하고, 이후 같은 토큰으로 오는 모든 요청은 즉시 거부한다. 다음 손님을 위해서는 FRONT가 테이블을 다시 OPEN할 때 **새로운 토큰을 가진 새 `TableSession` 레코드**를 생성한다 — 물리적 QR/NFC 태그 자체는 "테이블 슬러그"만 담고, 실제 유효 토큰은 서버가 리다이렉트 시점에 매핑하는 방식과, 세션마다 완전히 새 URL을 발급하는 방식 두 가지를 검토했다(아래 참고).

### QR/NFC 물리 태그 갱신 문제와 해결

물리적 QR 스티커나 NFC 태그를 테이블 오픈마다 재발급하는 것은 운영상 불가능하다(부스 운영자가 매번 스티커를 바꿔 붙일 수 없음). 따라서 다음과 같이 **간접 레벨을 하나 추가**한다.

```text
Table.public_slug  (물리적 QR/NFC에 인코딩되는 고정값, 테이블당 1개, 추측 불가 토큰)
        │
        ▼  GET /t/{public_slug}
서버가 해당 Table의 "현재 ACTIVE한 TableSession"이 있는지 조회
        │
        ├─ 있음 → 손님용 앱으로 진입, 이후 모든 API 호출은 서버가 발급한
        │          단기 쿠키(세션 식별자)로 이루어지며 이 쿠키가 TableSession.id를 가리킴
        │
        └─ 없음(CLOSED/AVAILABLE) → "현재 주문 가능한 테이블이 아닙니다" 안내 화면
```

- `Table.public_slug`는 고정이지만 그 자체로는 주문 권한을 주지 않는다 — 반드시 서버가 "현재 ACTIVE TableSession 존재 여부"를 재확인해야 접근이 열린다.
- `public_slug` 접근 시 서버는 손님 브라우저에 `HttpOnly` 쿠키(TableSession.id 서명값 또는 랜덤 세션 식별자)를 심어, 이후 API 호출은 URL의 slug가 아니라 **쿠키에 담긴 세션 식별자**로 스코프된다(URL을 다른 사람에게 그대로 공유해도 그 사람은 자신의 새 쿠키로 접근하게 되어, 서버가 그 시점의 TableSession 유효성을 동일하게 재검증한다 — 이미 CLOSE된 세션이면 동일하게 차단됨).
- `public_slug` 자체도 32바이트 이상 CSPRNG 기반이며, ADMIN이 필요 시 회전(rotate)할 수 있다(분실/유출 의심 시).

### 서버 검증 체크리스트 (매 손님 API 요청마다)

1. 쿠키/토큰이 유효한 `TableSession`을 가리키는가
2. 해당 `TableSession.status == ACTIVE`인가
3. 연결된 `Table.status == OPEN`인가
4. 요청 대상 리소스(주문/결제 조회 등)가 **이 TableSession 소유**인가 (다른 세션의 데이터 접근 차단)
5. Rate limit 초과 여부

### Rate Limit

- `public_slug` 및 손님 API 전체에 IP+세션 조합 기준 rate limit 적용(예: 분당 30회) — 무차별 슬러그 열거 및 남용 방지.

## 이유

- 순수 opaque 토큰만으로는 "물리 QR/NFC를 매번 재발행해야 하는" 운영상 문제가 생긴다. `public_slug`(물리 태그 고정값) + `TableSession.token`(세션별 동적 유효성) 2단 구조로, 운영 편의성과 보안 요구사항(세션 폐기 시 즉시 차단)을 동시에 만족시킨다.
- 모든 단계에서 "토큰이 존재한다"는 사실이 아니라 "현재 ACTIVE한 세션과 연결되어 있는가"를 서버가 재검증하므로, 토큰 추측/재사용만으로는 주문할 수 없다(`docs/RESEARCH.md` Agent D의 "암호화 난독화만으로는 IDOR을 막지 못한다"는 원칙 반영).

## 적용하지 않는 것

- 테이블마다 물리 QR을 오픈할 때마다 재인쇄하는 방식은 채택하지 않는다(운영 비현실적).
