# HANDOFF.md

> 다른 에이전트/개발자가 이 문서만 읽고 이어받을 수 있도록 최신 상태를 유지한다.

## 현재 단계

Phase 2~6 구현 완료. Phase 7(안정화) 진행 중 — 감사로그 정리, 운영 매뉴얼, Playwright E2E까지 완료. 남은 것은 실기기 테스트와 UI 디자인 폴리싱. (2026-09-12)

## 로컬 실행 방법

```bash
npm install
cp .env.example .env   # 값 채우기 (SESSION_SECRET, ADMINID/... 등)
npm run prisma:migrate --workspace server   # 최초 1회: 마이그레이션 + 시드 자동 실행
npm run dev:server      # http://localhost:3000
npm run dev:client      # http://localhost:5173 (API/소켓은 3000으로 프록시)
```

**주의**: `.env`의 `DATABASE_URL`은 반드시 `?connection_limit=1` 쿼리 파라미터를 포함해야 한다(예: `file:./dev.db?connection_limit=1`). 이는 결제 동시성 제어의 핵심 전제다(`docs/adr/0005-sqlite-write-concurrency.md`).

프로덕션 유사 실행: `npm run build:client && npm run build:server && npm run --workspace server start` (client/dist를 서버가 정적 서빙).

**서버 테스트**: `cd server && npx vitest run` (격리된 SQLite 테스트 DB 자동 생성/정리, 13개 파일/90개 테스트 전부 통과).

**E2E 테스트(Playwright)**: `npm run test:e2e` (루트에서 실행). `e2e/scripts/prepare-and-start.mjs`가 클라이언트 빌드 + 격리된 DB(`server/prisma/e2e.db`) 마이그레이션/시드 + 서버 기동을 자동으로 해주므로 dev 서버를 미리 띄울 필요 없다. 최초 1회 `cd e2e && npx playwright install chromium` 필요(시스템 의존성 설치 권한이 없는 샌드박스에서는 `--with-deps` 없이 브라우저 바이너리만 받아도 이 환경에서는 정상 동작했다 — CI에서는 `--with-deps` 사용).

로컬 브라우징용 데모 데이터: `cd server && npx dotenv -e ../.env -- npx tsx prisma/seedDemo.ts` (테이블 3개 + 메뉴 + 옵션 + 진행 중인 주문 1건 생성).

## 지금까지 완료된 것

- GitHub 저장소 `boardbite-pos`(https://github.com/deploy103/boardbite-pos), Phase 0 조사(`docs/RESEARCH.md`), Phase 1 설계(ADR 0001~0005, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TEST-PLAN.md`).
- **Phase 2 핵심 기반**: 인증, RBAC, 테이블 2단 토큰, 손님 세션 검증, 메뉴 CRUD, 주문 생성(서버측 가격재계산+idempotency), 해시체인 감사로그.
- **Phase 3 주방/KDS**: 주문 상태 머신(`order.ts`), POS 화면(4컬럼 보드, 경과시간 배지, 사유 모달, 이력/품절 탭), 고객 화면(옵션/장바구니 바텀시트, 상태 타임라인, 직원호출).
- **Phase 4 SERVING**: READY 목록/최근서빙완료, 서빙완료/되돌리기(시간창 정책), 직원호출 ack/done.
- **Phase 5 결제/정산 (가장 큰 작업)**: 부분/복합/더치/상품별 결제를 API 하나로 통합(`payment.ts`), 현금 받은금액/거스름돈, 할인, 결제취소(VOID/REFUND), 완납 자동 CLOSE/PAID_PENDING_SERVICE, SQLite 전용 동시성 설계(ADR 0005). `client/src/pages/front/CheckoutPage.tsx` + 8개 하위 컴포넌트.
- **Phase 6 ADMIN 고도화**: 결제수단 관리, 운영 설정(전체 주문/결제 킬스위치, KDS 지연기준 등 "하드코딩 금지" 원칙 적용), 테이블별 주문/결제 잠금, 결제 내역 검색, 매출 현황, DB 백업(생성/목록/다운로드 — UI 포함), CSV 내보내기, **감사 로그 정리(purge) + 해시체인 정합성 유지**.
- **Phase 7 안정화 (진행 중, 상당 부분 완료)**:
  - `docs/OPERATIONS.md` 전면 작성(학생도 따라할 수 있는 운영 매뉴얼).
  - **Playwright E2E 신규 도입**(`e2e/` 워크스페이스): 시나리오 A(정상 흐름 전체, 4개 역할의 실제 브라우저 컨텍스트), 시나리오 D(더블탭), H(권한 우회+클라이언트 리다이렉트), I(CLOSED 테이블 차단) — 전부 통과. CI에도 `e2e` 잡으로 추가됨.
  - 문서화 과정에서 실제 버그 2건 발견 및 수정: 백업 UI 누락, WSL DrvFs에서 `fs.Stats.birthtime` 미지원으로 백업 생성일자가 1970년으로 나오는 버그.
- **테스트 총계**: 서버 13개 파일/90개(Vitest+Supertest), E2E 2개 파일/4개(Playwright). 서버·클라이언트 `tsc --noEmit` 클린, `npm run build`(client) 성공.

## 아직 안 된 것

- **실기기 테스트**: iPhone Safari/Android Chrome/iPad에서의 실제 확인은 이 환경에서 수행 불가 — 사람이 직접 해야 함.
- UI 디자인 폴리싱: 1차 패스 완료(2026-09-12, `docs/DEVLOG.md` 참고 — KDS 4단 보드 잘림, 설정 화면 라벨 누락, 결제수단 화면 버튼 줄바꿈 3건 수정). Playwright로 스크린샷을 찍어 검토하는 방식이 이 환경에서도 통한다는 걸 확인했으니, 후속 작업자도 같은 방식(임시 스크립트로 로그인→조작→`page.screenshot()`→`Read` 도구로 확인, 끝나면 스크립트는 삭제)을 쓰면 된다. 다만 아직 전체 화면을 다 보진 못했으므로(결제내역/사용자/이용권/감사로그/메뉴 관리 탭 등 미검토) 계속 이어서 볼 것.
- ~~Playwright 시나리오는 Desktop Chrome 뷰포트만 다룬다~~ → 2026-09-12에 완료: 손님 대면 컨텍스트(시나리오 A/D/I)는 `devices["iPhone 13"]`로 띄우도록 변경. FRONT/POS/SERVING/ADMIN은 매장 데스크톱 기준 그대로 유지(실익 대비 실행시간만 늘어남). 별도 모바일 `projects`를 추가하는 대신 손님 컨텍스트만 디바이스 프로필을 적용하는 방식을 택함 — 스태프 화면까지 전부 두 번 돌릴 필요는 없다고 판단.
- 매출 리포트 `since` 필터는 시작일만 지원(종료일 없음).
- `npm audit` moderate 취약점(react-router-dom, express→qs) — major 업그레이드 검토 보류 중.
- **인프라 주의사항**:
  1. WSL(`/mnt/c/...`) 환경에서 `tsx watch`/Vite dev 서버가 파일 저장만으로 반영되지 않거나 간헐적으로 종료되는 현상이 있다. 코드 변경 후 반영 안 되면 수동 재시작. **죽었는지 확인할 때는 curl 실패 한 번만으로 판단하지 말고 `ps -ef | grep <프로세스>`와 `ss -ltnp | grep <포트>`로 재확인할 것**(오탐 경험 있음). **역방향 오탐도 있다**: 프로세스는 살아있는데 파일 변경 감지(chokidar)가 조용히 실패해서 몇 시간 전 코드로 계속 응답하는 경우가 반복 발생했다(2026-09-12, KDS CSS 수정/ADMIN 백업 탭/백업 타임스탬프 버그 재조사 때 3연속 재현 — 자세한 건 DEVLOG 참고). **코드를 고친 뒤 "진짜 반영됐는지"를 확인할 때는 브라우저/curl로 확인하기 전에 반드시 해당 dev 서버 프로세스를 kill 하고 재기동할 것.** 에러 메시지 없이 조용히 실패하므로 매우 헷갈린다.
  2. `npx vitest run`을 동시에 두 개 이상 돌리면 공유 SQLite 테스트 DB(`server/prisma/test.db`)가 충돌한다(순차 실행할 것). Playwright E2E는 별도 DB(`e2e.db`)를 쓰므로 vitest와는 충돌하지 않지만, E2E끼리 동시 실행은 마찬가지로 피할 것.
  3. `fs.Stats.birthtime`은 이 환경(WSL DrvFs)에서 항상 epoch를 반환한다 — 파일 생성 시각이 필요하면 파일명에 인코딩하거나 `mtime`을 쓸 것(`server/src/services/backup.ts` 참고 사례).

## 다음 작업자가 가장 먼저 할 일

1. `docs/DEVLOG.md` 최신 항목을 읽는다. dev 서버가 죽어있으면 재시작한다.
2. 브라우저로 `/front/checkout/:id`, `/serving`, `/admin`의 새 화면들을 직접 열어보고 디자인을 다듬는다(요구사항.md §15, docs/RESEARCH.md Agent C 원칙 참고).
3. 사람이 실기기(iPhone/Android/iPad)로 직접 접속해 확인 — 이 문서와 `docs/TEST-PLAN.md` §5 체크리스트를 따른다.
4. 여유가 되면 Playwright에 모바일 뷰포트 프로젝트를 추가(`playwright.config.ts`의 `projects` 옵션).

## 알려진 blocker

없음.
