# BoardBite POS

학교 반 부스에서 운영하는 보드게임 카페형 행사를 위한 **테이블오더 + KDS(주방) + POS + 정산** 통합 시스템.

> 인증/RBAC/테이블/메뉴/주문(Phase 2), 주방 KDS(Phase 3), 서빙(Phase 4), 부분/복합/더치/상품별 결제와 정산(Phase 5),
> 결제수단·운영설정·매출현황·백업 등 관리자 고도화(Phase 6), 안정화(Phase 7), 운영 투입 전 보안 하드닝(Phase 8)까지 구현되어 있습니다.

## 운영 흐름 요약

```text
손님 입장 → FRONT 자리 배정 → 테이블 OPEN(이번 자리 전용 6자리 입장 코드 발급)
→ 손님이 NFC/QR로 접속 후 입장 코드 입력 → 주문
→ 주방(KDS) 접수/조리 → SERVING 서빙 완료 → FRONT 정산(부분/복합/더치/상품별)
→ 잔액 0 → 손님 기기 세션 폐기 → 테이블 자동 CLOSE
→ 영업 종료 시 ADMIN 영업 마감(현금 대조 + 스냅샷 기록)
```

## 기술 스택

Node.js(TypeScript) + Express + Prisma + SQLite + React(Vite) + Socket.IO.

---

## 보안 모델 요약

운영 중 사고를 막기 위한 핵심 규칙입니다. 자세한 근거는 각 소스 파일 주석에 있습니다.

| 주제 | 규칙 |
| --- | --- |
| 손님 입장 | QR/NFC의 `/t/<slug>`는 **테이블 식별만** 한다. 접근 권한은 그 세션에서만 유효한 6자리 입장 코드로만 발급된다. 저장해 둔 예전 링크로는 새 세션에 들어갈 수 없다. |
| 손님 세션 | 쿠키에는 32byte 랜덤 토큰, DB에는 그 해시만 저장. 테이블을 닫으면 즉시 전부 무효화된다. |
| 직원 인가 | 세션에 캐시된 role은 판단 근거가 아니다. 매 요청마다 DB에서 계정을 다시 읽고 `isActive`/`authVersion`/현재 role을 확인한다. |
| 세션 무효화 | 권한 변경·비활성화·비밀번호 변경/초기화·MFA 해제 시 `authVersion`이 올라 그 계정의 **모든 기존 세션이 즉시 끊긴다.** |
| 실시간(Socket.IO) | 클라이언트는 room을 고를 수 없다. 서버가 세션 쿠키를 검증해 DB의 현재 role로만 room을 배정한다. |
| 관리자 보호 | production ADMIN은 TOTP 2단계 인증 필수. 고위험 작업은 최근 5분 이내 재인증(step-up)이 없으면 거부된다. |
| 금액/상태 | 가격·합계·상태 전이는 전부 서버가 DB에서 다시 계산한다. 상태 전이는 조건부 UPDATE로 처리해 동시 요청에서 한쪽만 성공한다. |
| 감사 로그 | 모든 보안·금전 이벤트를 HMAC-SHA256 체인으로 기록한다. 키는 DB에 저장하지 않는다. |

### step-up 재인증이 필요한 작업

비밀번호(+ MFA 사용 시 TOTP)를 다시 확인해야 하고, 통과 후 5분간만 유효합니다.

- 직원 권한 변경 / 계정 비활성화 / 비밀번호 초기화 / MFA 해제
- 결제 취소(VOID) 및 환불(REFUND)
- 테이블 강제 종료
- DB 백업 생성 및 다운로드
- 감사 로그 삭제
- 영업 마감 확정

---

## 환경변수

`.env.example`을 복사해 사용합니다. production 기동 시 서버가 아래 값을 검사하고, 기준을 못 넘기면 **아예 기동하지 않습니다.**

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `SESSION_SECRET` | 항상 | 세션 쿠키 서명 키. production은 32자 이상. 바꾸면 기존 로그인 세션이 전부 무효화된다. |
| `AUDIT_HMAC_KEY` | production | 감사 로그 HMAC 체인 키(32자 이상). DB에 저장하지 않는다. 분실하면 기존 로그의 무결성 검증이 불가능해진다. |
| `MFA_ENCRYPTION_KEY` | production | TOTP secret 봉인용 AES-256-GCM 키(32자 이상). 분실하면 모든 관리자가 인증 앱을 재등록해야 한다. |
| `ADMINID` / `ADMINPASSWORD` | 항상 | 부트스트랩 관리자 계정. **시드가 만드는 유일한 계정**이며, 직원 계정은 관리자 화면에서 등록한다. |
| `DATABASE_URL` | 항상 | SQLite 경로. **반드시 `?connection_limit=1`을 포함**해야 한다 — 결제 동시성 제어의 전제다. |
| `PORT` / `NODE_ENV` | - | 로컬 실행용. Docker에서는 compose가 덮어쓴다. |
| `HOST_PORT` / `HOST_BIND` | - | Docker가 호스트에 노출할 포트/주소. 기본 바인딩은 `127.0.0.1`. |
| `CUSTOMER_RATE_LIMIT_PER_MIN` | - | 손님 API의 IP당 분당 허용 횟수(기본 60). 손님들이 같은 공유기를 쓰면 올린다. |
| `STAFF_LOGIN_RATE_LIMIT_PER_5MIN` | - | 로그인 API의 IP당 5분 허용 횟수(기본 20). |
| `SENSITIVE_AUTH_RATE_LIMIT_PER_10MIN` | - | MFA 인증번호 확인 / step-up / 비밀번호 변경의 IP당 10분 허용 횟수(기본 40). |
| `TRUST_PROXY` | - | X-Forwarded-For 신뢰 홉 수(기본 1 = Nginx 1대). **프록시 없이 직접 노출하면 반드시 `0`.** |

### 계정 모델

시드는 **부트스트랩 ADMIN 계정 하나만** 만듭니다. FRONT/POS/SERVING 계정은 환경변수로 만들지 않고,
그 ADMIN으로 로그인해 **관리자 화면 > 사용자 탭에서 직접 등록**합니다. 그래야 감사 로그에
"누가 이 계정을 만들었는지"가 남고, 주인 없는 공용 계정이 `.env`에 방치되지 않습니다.

| | ADMIN | FRONT / POS / SERVING |
| --- | --- | --- |
| 비밀번호 최소 길이 | **15자** | **10자** |
| 2단계 인증(TOTP) | **필수** (production에서 미설정 시 관리 기능 전부 403) | 선택 — 등록 여부는 관리자 화면 배지로 확인 |
| 계정 생성 경로 | 시드(최초 1개) 또는 관리자 화면(step-up 재인증 필요) | 관리자 화면에서만 |

### 비밀번호/키 정책

- 비밀번호 최소 길이는 **모든 환경(개발/테스트/운영)에서 동일**합니다 — ADMIN 15자, 그 외 10자.
- `change-me` 같은 기본값 금지, 아이디와 동일한 값 금지.
- 복잡도(대문자/특수문자) 강제는 하지 않습니다. 기억하기 쉬운 긴 문장을 권장합니다.
- 비밀 키는 32자 이상이어야 하며 `SESSION_SECRET`과 `ADMINPASSWORD`가 같으면 거부됩니다.

강한 랜덤값 생성:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> `.env`의 실제 값, TOTP secret, 백업 파일은 절대 Git에 커밋하거나 채팅/문서에 붙여넣지 마세요.

---

## 로컬 실행

요구사항: Node.js 22 이상.

```bash
npm install

cp .env.example .env
# .env를 열어 ADMIN 계정/비밀키 값을 채운다.

# 최초 1회: DB 마이그레이션 + 부트스트랩 ADMIN 계정 시드
npm run prisma:migrate --workspace server
npm run prisma:seed --workspace server

# 개발 서버 (터미널 두 개)
npm run dev:server   # http://localhost:3000 — API + Socket.IO
npm run dev:client   # http://localhost:5173 — /api, /socket.io는 3000으로 프록시
```

`/staff/login`에서 부트스트랩 ADMIN 계정으로 로그인하면 서버가 역할을 판정해 `/admin`으로 이동시킵니다.

> 부트스트랩 ADMIN 계정은 첫 로그인에서 **비밀번호 변경 화면으로 강제 이동**합니다. 변경 전에는 업무 화면을 쓸 수 없습니다.
> production에서는 이어서 **2단계 인증(TOTP) 등록**까지 마쳐야 관리 기능이 열립니다.

FRONT/POS/SERVING 화면을 쓰려면 먼저 `/admin` > **사용자** 탭에서 각 역할의 계정을 만드세요.

손님 화면을 확인하려면 FRONT에서 테이블을 연 뒤 화면에 표시되는 **입장 코드**를 `/t/<publicSlug>`에서 입력하세요.

### 프로덕션 유사 실행 (단일 프로세스)

```bash
npm run build:client
npm run build:server
npm run --workspace server start
```

### 테스트

```bash
cd server && npx vitest run
```

격리된 SQLite 테스트 DB(`server/prisma/test.db`)를 자동으로 생성/정리하며, 개발용 `.env`나 `dev.db`에 영향을 주지 않습니다.

### E2E 테스트 (Playwright)

```bash
npx playwright install chromium   # 최초 1회
npm run test:e2e
```

두 종류의 서버를 자동으로 띄워 검증합니다.

- `http` 프로젝트: 일반 개발 조건(`server/prisma/e2e.db`).
- `secure` 프로젝트: **`NODE_ENV=production` + 자체 서명 HTTPS 프록시** 뒤에서 Secure 쿠키, ADMIN MFA 강제,
  입장 코드 흐름, 주문→정산까지 전 구간(`server/prisma/e2e-secure.db`). 인증서 생성을 위해 `openssl`이 필요합니다.

---

## Docker로 서버에 배포

```bash
git clone <저장소 URL> && cd boardbite-pos
cp .env.example .env   # 값 채우기 (ADMIN 계정 비밀번호 + 3개 비밀키)

# 볼륨 디렉터리 소유자를 컨테이너의 non-root 사용자(uid/gid 1000)로 맞춘다.
mkdir -p data/db data/backups
sudo chown -R 1000:1000 data

docker compose up -d --build
```

빌드, DB 마이그레이션, 부트스트랩 ADMIN 계정 시드까지 이 한 번의 명령으로 끝납니다.
기동 후 `/staff/login`에서 ADMIN으로 로그인 → 비밀번호 변경 → 2단계 인증 등록 →
관리자 화면에서 직원 계정을 등록하는 순서로 진행하세요.

- SQLite DB와 백업 파일은 `./data/db`, `./data/backups`에 저장되어 컨테이너를 내렸다 올려도 유지됩니다.
- 컨테이너는 **non-root(`node`, uid 1000)** 로 실행되고, `no-new-privileges`와 전체 capability drop이 적용됩니다.
  애플리케이션 소스는 root 소유라 컨테이너 안에서 수정할 수 없고, 쓰기가 가능한 곳은 DB/백업 디렉터리뿐입니다.
- 포트는 기본적으로 **`127.0.0.1`에만 바인딩**되어 외부에서 3000번에 직접 붙을 수 없습니다.
  앞단 리버스 프록시가 같은 서버에 있다는 전제입니다. 포트를 바꾸려면 `.env`에 `HOST_PORT=<포트>`를 넣으세요.
- 상태 확인:
  - `curl http://127.0.0.1:${HOST_PORT:-3000}/healthz` → `{"ok":true}` (프로세스 살아있음)
  - `curl http://127.0.0.1:${HOST_PORT:-3000}/readyz` → `{"ok":true}` (DB까지 정상, 아니면 503)
- 코드 업데이트 후 재배포: `git pull && docker compose up -d --build` (마이그레이션/시드는 멱등이라 반복 실행해도 안전).

### Nginx 리버스 프록시 설정

세션 쿠키는 `NODE_ENV=production`에서 `Secure` 속성이 강제되므로 **HTTPS 종단이 반드시 필요**합니다.
아래 헤더를 전달하지 않으면 rate limit이 모든 손님을 한 사람으로 묶어 계산하거나, 로그인이 아예 되지 않습니다.

```nginx
# WebSocket이 아닌 일반 요청까지 `Connection: upgrade`로 보내면 업스트림이 응답을
# 끝내지 못해 504 Gateway Timeout이 난다. Upgrade 헤더가 있을 때만 upgrade로 넘기고
# 평소에는 close가 되도록 이 map을 http {} 블록에 둔다(필수).
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name booth.example.com;

    ssl_certificate     /etc/letsencrypt/live/booth.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/booth.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;

        # 아래 4개는 필수다.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Socket.IO(WebSocket) upgrade — 없으면 실시간 갱신이 동작하지 않는다.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 600s;
    }
}

server {
    listen 80;
    server_name booth.example.com;
    return 301 https://$host$request_uri;
}
```

---

## 운영 가이드

### 관리자 2단계 인증(MFA) 설정

1. ADMIN으로 로그인하면 production에서는 자동으로 `/staff/mfa-setup`으로 이동합니다.
2. 현재 비밀번호를 다시 입력하면 secret이 **그 화면에서 한 번만** 표시됩니다.
3. 인증 앱(Google Authenticator, 1Password 등)에 등록한 뒤 6자리를 입력하면 활성화됩니다.
4. 이후 로그인은 ID/PW → 6자리 순서로 진행됩니다.

인증 앱을 분실하면 **다른 ADMIN 계정**이 사용자 관리 화면에서 `MFA 해제`를 실행해야 합니다(step-up 필요).
그래서 **관리자 계정은 최소 2개 이상 만들어 두는 것을 강력히 권장**합니다.

### 직원 계정 등록

FRONT/POS/SERVING 계정은 관리자 화면 > **사용자** 탭에서만 만들 수 있습니다(비밀번호 10자 이상).
공용 계정 하나를 돌려쓰지 말고 **담당자별 개인 계정**을 만드세요 — 감사 로그에 "누가" 했는지가
남아야 사고 원인을 추적할 수 있습니다. 직원 계정의 2단계 인증은 선택이며, 등록 여부는
같은 화면의 `MFA 사용` / `MFA 없음` 배지로 확인합니다.

ADMIN 역할 계정을 추가로 만들 때는 권한 상승에 해당하므로 **step-up 재인증**(비밀번호 + TOTP)이 한 번 더 필요합니다.

### 손님 입장 코드 운영

- 테이블을 열면 FRONT 화면에 **이번 자리 전용 6자리 코드**가 뜹니다. 손님에게 바로 안내하세요.
- 평문 코드는 서버에 저장되지 않습니다. 놓쳤다면 FRONT의 `입장 코드 재발급`을 사용하세요.
  이미 입장한 손님 기기는 그대로 유지되고, 새로 들어오는 기기만 새 코드를 씁니다.
- 테이블을 닫으면 코드와 손님 기기 세션이 즉시 무효화됩니다.

### 테이블 종료

- **일반 종료(FRONT)**: 미결제 금액·미서빙 주문·미처리 호출이 하나라도 있으면 거부되고 사유가 표시됩니다.
- **강제 종료(ADMIN)**: 별도 화면에서 사유 입력 + step-up 재인증을 거쳐야 하며,
  남은 금액과 미서빙 주문 현황이 감사 로그에 그대로 기록됩니다. 삭제가 아니라 "기록이 남는 종료"입니다.

### 영업 마감

ADMIN → `영업 마감` 탭에서 진행합니다.

1. 직전 마감 이후의 총 주문 금액·실제 매출·할인·VOID·REFUND·결제수단별 매출을 확인합니다.
2. **현금 예상액**과 실제 금고 현금을 입력하면 차액이 계산됩니다.
3. 사용 중인 테이블이 남아 있으면 경고가 뜨고, 강행하려면 사유가 필수입니다.
4. 확정 시 step-up 재인증을 거치며, 결과는 수정 불가한 스냅샷으로 저장됩니다.
   정정이 필요하면 새 마감 기록을 추가하고 메모를 남기세요.
5. `마감 내역 CSV 내려받기`로 내보낼 수 있습니다.

### DB 백업과 복원

백업 생성/다운로드 모두 step-up 재인증이 필요합니다(파일에 전체 원장이 들어 있습니다).

```bash
# 백업: ADMIN → 백업 탭 → "백업 생성" → 목록에서 내려받기
#      (또는 호스트에서 직접)
cp data/db/boardbite.db ~/boardbite-backup-$(date +%Y%m%d-%H%M).db

# 복원
docker compose down
cp ~/boardbite-backup-20260919-1830.db data/db/boardbite.db
sudo chown 1000:1000 data/db/boardbite.db
docker compose up -d
```

화면에 표시되는 SHA-256 체크섬으로 복원한 파일이 원본과 같은지 확인할 수 있습니다.

> **복원 후에는 반드시 전 직원을 강제 로그아웃시키세요.** 백업 시점 이후에 바뀐 권한이 되살아날 수 있습니다.
> `.env`의 `SESSION_SECRET`을 새 값으로 교체한 뒤 재기동하면 기존 세션 쿠키가 전부 무효화됩니다.
> 손님 기기 세션도 함께 정리하려면 열려 있던 테이블을 모두 닫으세요.

### 네트워크가 끊겼을 때

화면 상단에 연결 상태 배너가 뜹니다. **같은 버튼을 반복해서 누르지 마세요.**
주문과 결제는 idempotency key로 보호되어 있어, 응답이 유실된 뒤 다시 시도해도 중복 생성되지 않습니다.
연결이 돌아오면 화면이 자동으로 서버 상태를 다시 읽습니다.

---

## 배포 전 체크리스트

- [ ] 부트스트랩 ADMIN 비밀번호를 15자 이상 값으로 변경
- [ ] `SESSION_SECRET` 강한 랜덤값(32자 이상)
- [ ] `AUDIT_HMAC_KEY` 강한 랜덤값(32자 이상) — 안전한 곳에 별도 보관
- [ ] `MFA_ENCRYPTION_KEY` 강한 랜덤값(32자 이상) — 안전한 곳에 별도 보관
- [ ] ADMIN 계정 2개 이상 생성 + 각각 MFA 설정 완료
- [ ] 관리자 화면에서 담당자별 FRONT/POS/SERVING 계정 생성(10자 이상)
- [ ] HTTPS 인증서 적용 및 `https://`로 접속 확인
- [ ] 외부에서 `<서버IP>:3000` 직접 접근이 차단되는지 확인
- [ ] 앞단 Nginx 없이 직접 노출하는 구성이라면 `TRUST_PROXY=0` 설정 (IP 기반 제한 우회 방지)
- [ ] `/healthz`, `/readyz` 모두 200 확인
- [ ] 백업 생성 테스트 + 복원 테스트(실제로 복원까지 해볼 것)
- [ ] 테이블별 NFC/QR이 올바른 `/t/<slug>`를 가리키는지 전수 확인
- [ ] 입장 코드 발급 → 손님 입장 → 재발급 흐름 확인
- [ ] 주문 버튼 더블탭 테스트(주문 1건만 생성되는지)
- [ ] 결제 더블 서브밋 테스트(결제 1건만 생성되는지)
- [ ] FRONT/POS/SERVING 각 계정으로 다른 화면에 접근되지 않는지 확인
- [ ] 미결제 테이블 일반 종료가 막히는지 + ADMIN 강제 종료가 기록되는지 확인
- [ ] Wi-Fi를 잠시 껐다 켜며 네트워크 끊김/복구 동작 확인
- [ ] 영업 마감 1회 리허설(현금 대조 포함)

---

## 기본 계정 (부트스트랩)

시드는 `.env`의 `ADMINID` / `ADMINPASSWORD`로 **ADMIN 계정 하나만** 만듭니다(`.env.example` 참고).
첫 로그인 시 비밀번호 변경이 강제되고, production에서는 2단계 인증 등록까지 마쳐야 관리 기능이 열립니다.
나머지 직원 계정은 그 뒤 관리자 화면에서 등록합니다.

## 라이선스

[MIT](LICENSE)
