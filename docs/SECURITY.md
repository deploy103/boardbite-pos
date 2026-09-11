# SECURITY.md

> Phase 0/1 산출물. 근거 조사는 `docs/RESEARCH.md`(Agent D), 설계 반영은 `docs/adr/0003-auth-session.md`, `docs/adr/0004-table-token.md` 참고. 구현 단계마다 갱신한다.

## 1. 위협 → 대응 매핑

| 위협 | 대응 | 구현 위치 |
|---|---|---|
| IDOR/BOLA(다른 테이블/주문/결제 접근) | 모든 손님 API는 요청 파라미터가 아니라 쿠키에서 유도된 `TableSession`으로 쿼리 스코프. 순차 ID 미노출 | `docs/adr/0004-table-token.md`, 손님 API 미들웨어 |
| 순차 테이블 번호 조작 | 물리 URL은 `Table.publicSlug`(CSPRNG), 내부 PK 비노출 | Table/TableSession 모델 |
| 공개 QR URL 공유 | slug 자체는 "현재 ACTIVE 세션 존재 여부"만 확인하는 진입점일 뿐이며, 실제 주문 권한은 서버가 매 요청 재검증. 관리자가 slug 회전 가능 | `docs/adr/0004-table-token.md` |
| CLOSED 테이블 주문 | 주문 생성 공통 미들웨어에서 `TableSession.status==ACTIVE && Table.status==OPEN` 확인, 위반 시 409 | 주문 생성 API |
| 이전 손님 세션 재사용 | CLOSE 시 `TableSession.status=CLOSED` 즉시 반영, 이후 요청 403. 재오픈 시 신규 TableSession+새 쿠키 발급 | 테이블 CLOSE 처리 |
| 클라이언트 가격/수량 조작 | 서버가 `menuItemId`+옵션ID로 DB 현재가를 재계산, 클라이언트 price/total 필드 무시 | 주문 생성 API |
| 주문 더블탭/재전송 | `Idempotency-Key` + DB UNIQUE 제약으로 원자적 중복 차단 | Order 모델 `idempotencyKey` |
| 로그인 brute force | 계정 실패 5회/5분 잠금 + IP rate limit 병행 | 로그인 API |
| 세션 탈취/고정 | 로그인/역할변경 시 세션 재발급, `HttpOnly/Secure/SameSite` 쿠키 | `docs/adr/0003-auth-session.md` |
| CSRF | 상태변경 API에 CSRF 토큰(or 커스텀 헤더 요구) + SameSite 쿠키 병행 | 공통 미들웨어 |
| XSS | 프레임워크 기본 텍스트 바인딩만 사용, `dangerouslySetInnerHTML` 금지, CSP 헤더 | 프론트엔드 렌더링 규칙 |
| SQL Injection | Prisma 쿼리 빌더만 사용, raw SQL 문자열 결합 금지(코드리뷰 게이트) | 전체 DB 접근 계층 |
| Role escalation / 관리자 API 직접 호출 | 역할은 서버 세션+DB 재검증, `requireRole()` 미들웨어를 라우터 전체에 일괄 적용 | `/api/admin/*`, `/api/staff/*` |
| 결제 중복 처리 | 결제 생성도 `Idempotency-Key` 필수 | Payment 모델 |
| 동시 부분결제 race condition(초과결제) | 트랜잭션 + `SELECT ... FOR UPDATE` + 조건부 UPDATE | 결제 처리 서비스 로직 |
| Audit log tampering | append-only 테이블(UPDATE/DELETE 권한 제거) + 해시체인 | AuditLog 모델 |
| Public GitHub secret leak | `.env.example`만 커밋, Secret Scanning + Push Protection, CI에 Gitleaks | 저장소 설정(완료) |

## 2. 인증/세션 설계

`docs/adr/0003-auth-session.md`, `docs/adr/0004-table-token.md` 참고. 요약:

- 직원: 서버 세션(쿠키), bcrypt/argon2, 로그인/역할변경 시 세션 재발급, 실패 5회 잠금.
- 손님: `Table.publicSlug`(고정, 물리 QR/NFC) → 서버가 ACTIVE `TableSession` 확인 → 세션 쿠키 발급 → 이후 모든 API는 쿠키 기준 스코프.

## 3. 데이터 보호

- 모든 금액 KRW 정수, 부동소수점 금지.
- 카드 번호/유효기간/CVC 등 민감 결제정보는 **절대 수집/저장하지 않는다**(요구사항.md §12 명시) — `Payment.method='CARD'`는 "카드로 결제했다는 기록"일 뿐 실제 카드 데이터는 없음.
- 비밀번호는 해시만 저장, 로그에 평문 비밀번호를 남기지 않는다.
- 감사 로그의 `metadata`에도 비밀번호/카드정보 등 민감정보를 넣지 않는다.

## 4. 보안 헤더/전송 보안

- HTTPS 강제(리버스 프록시에서 HSTS 적용).
- CSP 예시: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`(또는 CSP frame-ancestors로 대체), `Referrer-Policy: same-origin`.

## 5. 보안 테스트 체크리스트

`docs/TEST-PLAN.md`와 연동. 최소 아래 시나리오를 자동/수동 테스트로 검증한다.

- [ ] 다른 테이블 slug/세션으로 주문·조회 시도 → 차단
- [ ] CLOSED 테이블 주문 시도 → 차단 + 안내 문구
- [ ] 이전 고객 세션(쿠키)으로 CLOSE 후 재주문 시도 → 차단
- [ ] 클라이언트가 가격/총액 조작해 주문 시도 → 서버가 무시하고 재계산
- [ ] 동일 주문 더블탭 → 1건만 생성
- [ ] POS 계정으로 `/api/admin/*` 호출 → 403
- [ ] SERVING 계정으로 결제 생성 API 호출 → 403
- [ ] 두 FRONT가 동시에 같은 테이블 결제 → 초과결제 없음
- [ ] 동일 상품 수량 일부만 결제 후 재결제 시도 → 초과분 차단
- [ ] 로그인 5회 실패 → 계정 잠금
- [ ] 감사 로그 해시체인 무결성 검증
- [ ] Public repo에 secret 없음(Gitleaks CI)
