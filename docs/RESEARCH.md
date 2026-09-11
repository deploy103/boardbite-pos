# RESEARCH.md

> 구현 전에 먼저 작성한다. 공식 문서/신뢰할 수 있는 자료를 우선한다.
> 조사 결과는 그대로 복제하기 위한 것이 아니라 BoardBite POS의 기능/UX/보안 결정을 위한 근거다.

## 조사 체크리스트

- [x] OKPOS 후불형/테이블 주문
- [x] OKPOS 받은금액/거스름돈
- [x] OKPOS 복합결제/부분결제
- [x] OKPOS QR오더
- [x] 배민 주문접수 PC/Lite
- [x] KDS 주문 상태/타이머/지연 표시
- [x] 상품별/더치/분할 정산 데이터 모델
- [x] QR/NFC 테이블 보안
- [x] OWASP IDOR/BOLA/RBAC/CSRF/XSS
- [x] Toss Design System
- [x] 사용자 제공 UX/UI 레퍼런스 (원문 접근 실패, 대체 조사로 보완 — 아래 Agent C 섹션 참고)
- [x] iOS Safari 모바일 UI
- [x] 네트워크 재연결/중복 주문
- [x] Public GitHub secret 관리

Phase 0 조사 5개 트랙(OKPOS/배민·KDS/UX·UI/보안/데이터·정산) 모두 완료. (2026-09-11)

---

## 자료 기록 템플릿

### 자료명

- 조사일:
- URL:
- 종류: 공식문서 / 도움말 / 기술문서 / 사례
- 신뢰도:

#### 핵심 내용

#### BoardBite POS에 적용할 내용

#### 적용하지 않을 내용

#### 이유

---

## 우선 확인할 URL

### OKPOS
- https://okpos.gitbook.io/okpos-guide/
- https://qr.okpos.co.kr/home

### 배민
- https://ceo.baemin.com/guide/13571
- https://ceo.baemin.com/guide/2050

### Toss
- https://developers-apps-in-toss.toss.im/design/components.html
- https://developers-apps-in-toss.toss.im/design/consumer-ux-guide.html

### 사용자 제공 UX/UI 레퍼런스
- https://medium.com/@bunny753358/%EC%9E%90%EC%A3%BC-%EC%82%AC%EC%9A%A9%ED%95%98%EB%8A%94-ux-ui-%EB%A0%88%ED%8D%BC%EB%9F%B0%EC%8A%A4-%EC%82%AC%EC%9D%B4%ED%8A%B8-91381826ca00

### OWASP
- https://owasp.org/www-project-top-ten/
- https://owasp.org/API-Security/
- https://cheatsheetseries.owasp.org/

---

# Agent B — 배민 주문접수 / KDS 조사

### 배민 사장님 가이드 - 배달의민족(가게배달/알뜰배달) 주문접수 방법

- 조사일: 2026-09-11
- URL: https://ceo.baemin.com/guide/13571
- 종류: 공식문서 (배민 사장님 지원 가이드)
- 신뢰도: 높음 (배민 공식 페이지, WebFetch로 직접 확인)

#### 핵심 내용
- 가게배달: "접수 버튼을 선택하고 배달시간을 선택합니다."
- 알뜰·한집배달: "조리시간을 선택하고, '조리시작' 알림이 뜨면 조리를 시작해주세요." — 접수 시점과 실제 조리시작 시점이 분리되어 있고, 별도의 "조리시작" 알림(라이더 배차/픽업 타이밍에 맞춤)이 온다.
- 준비완료: "조리와 포장이 완료되면 [준비완료] 버튼을 눌러 준비 완료 처리를 할 수 있습니다."
- 주문거부: "거부할 주문 건을 선택하고 화면 하단의 주문 거부하기를 클릭한 후, 거부사유를 선택해 처리할 수 있습니다." (거부사유 세부 목록은 본문에 명시되어 있지 않음 — 확인 못함)
- 취소: 알뜰·한집배달은 "배민라이더가 음식을 픽업하기 전까지만 파트너님께서 직접 주문을 취소하실 수 있어요." (사유 목록은 확인 못함)
- 연동: "가게에서 사용하고 있는 POS 프로그램만으로 배달의민족 주문을 접수/거부/취소/완료할 수 있습니다." — 배민은 자체 화면 없이도 POS 연동만으로 접수/거부/취소/완료의 4단계 상태를 관리하게 설계됨.

#### BoardBite POS에 적용할 내용
- "접수(수락)"와 "조리시작"을 별도 이벤트로 분리하는 개념 — BoardBite는 배달이 아니므로 라이더 픽업 개념은 없지만, "신규 접수 → 조리 시작 → 준비완료"의 3단계 상태 전이 구조는 그대로 채택.
- 준비완료를 명시적 버튼 액션으로 만드는 것(자동 타이머 종료가 아니라 담당자가 직접 확인 후 완료 처리).
- POS/KDS 단일 화면에서 접수/거부/취소/완료를 모두 처리할 수 있게 하는 원칙(별도 채널 오가지 않고 한 화면에서 상태 전이).

#### 적용하지 않을 내용
배달시간/픽업시간 등 라이더 관련 개념, "라이더 출발" 알림, 거부사유의 구체적 문구(확인 불가로 그대로 가져올 수 없음).

#### 이유
BoardBite POS는 행사장 내 취식이므로 배달 물류(라이더, 배달시간)가 존재하지 않는다. 상태 전이 구조(접수→조리→완료)만 원칙으로 차용하고, 배달 특화 요소는 제외한다.

---

### 배민 사장님 가이드 - 주문접수 프로그램(PC/PC Lite/앱) 설치 및 사양

- 조사일: 2026-09-11
- URL: https://ceo.baemin.com/guide/2050
- 종류: 공식문서 (설치/사양 가이드)
- 신뢰도: 높음(공식 페이지), 단 문서 내 동시접속 대수 정보가 상충(PC 2대+모바일 5대 vs PC 2대+스마트폰 2대 총 4대)하여 세부 수치는 낮은 신뢰도로 취급

#### 핵심 내용
- "배민사장님 앱"과 "배민주문접수PC" 두 채널이 실시간으로 연동되며 동시에 여러 대의 기기에서 같은 주문 상태를 볼 수 있다(정확한 대수는 문서 내 상충).
- 주문별 알림음 구분, 최대 5대 프린터 연결 등 부가기능 언급 — 주문 유형(배달/포장 등)별 알림음을 다르게 설정하는 기능이 실제 존재.
- 배민주문접수 PC가 메인 접수 채널로 설정된 경우에만 특정 결제 기능이 활성화되는 등 "메인 기기" 개념이 존재.

#### BoardBite POS에 적용할 내용
- 여러 대의 기기(주방 KDS 태블릿 + 카운터 POS)가 하나의 주문 상태를 실시간 동기화해서 보여주는 멀티 디바이스 동기화 원칙.
- 주문 유형별(예: 포장 vs 매장취식) 알림음을 다르게 설정할 수 있는 기능 아이디어.

#### 적용하지 않을 내용
프린터 5대 연동, 결제 채널별 "메인 기기" 지정 같은 배달앱 결제 연동 특유의 제약.

#### 이유
BoardBite는 소규모 부스 행사이므로 기기 대수 제한이나 프린터 다중 연결 같은 대형 매장 인프라 요소는 과설계다. "여러 화면이 동일 상태를 공유"하는 기본 아키텍처 원칙만 채택한다.

---

### 국내 상용 주문접수 프로그램 사용 흐름 종합 (검색 요약 — 접수대기/처리중/완료 탭)

- 조사일: 2026-09-11
- URL: 다수 출처 종합, 원문 미직접 열람 다수 포함. 참고: https://tossplace.com/story/windows_baemin , https://ceo.baemin.com/guide/10592 , https://s3.ap-northeast-2.amazonaws.com/ceo.baemin.com/notice/baro-order/2019_pc_manual_v3.4.1.pdf
- 종류: 도움말/사례 (검색엔진 요약, 원문 미직접 열람 포함 — 추정 포함)
- 신뢰도: 중간 (특히 PDF/브런치 글은 비공식 해석 가능성 있음)

#### 핵심 내용
- [접수대기] → [처리중] → [완료] 3개 탭 구조가 여러 검색 결과에서 반복 확인됨.
- 상품 준비시간을 사장님이 직접 +/- 조절 가능(대략 5~45분 범위로 추정 — 확인 안 됨), 일정 시간(예: 15분) 내 미접수 시 자동취소된다는 서술(확인 안 됨, 추정).
- 정렬 방식이 "접수시간순 단순 정렬"이라 조리시작 상태 주문을 찾기 위해 수동으로 넘겨봐야 하는 불편함이 실사용자 피드백으로 언급됨.
- 완료된 주문도 사후 취소 가능하며 취소 내역은 POS 현황에서 조회 가능.

#### BoardBite POS에 적용할 내용
- [접수대기]/[조리중]/[완료] 3탭 구조 채택 (배달 없으므로 "배달중" 탭은 제외).
- "단순 시간순 정렬은 상태 파악이 어렵다"는 반면교사 — KDS는 탭 내에서도 지연 주문 우선 정렬 또는 상태별 하이라이트를 적용.
- 완료 주문에 대한 사후 취소/정정 이력 관리 기능 반영.

#### 적용하지 않을 내용
15분 자동취소, 5~45분 준비시간 슬라이더 등 배달앱 특유의 수치는 확인되지 않았으므로 그대로 가져오지 않음.

#### 이유
1차 출처 미확인 수치는 그대로 복제하지 않는다. 탭 구조/정렬 이슈 같은 구조적 UX 원칙만 반면교사로 채택한다.

---

### 토스플레이스 - 후불형 매장용 KDS 기능 소개

- 조사일: 2026-09-11
- URL: https://tossplace.com/story/postpaid_kds
- 종류: 사례 (벤더 소개 글, 검색 요약 기반)
- 신뢰도: 중간 (공식 벤더 콘텐츠, 마케팅성 소개 글, WebFetch 미실시)

#### 핵심 내용
- KDS는 홀에서 등록한 주문이 자동으로 포스/디스플레이 화면에 표시되어 종이 주문서를 대체.
- 주방 섹션(볶음/튀김/냉채 등)별로 전체 주문을 확인하고 서빙하는 매장에 적합 — "섹션(스테이션)별 주문 확인" 지원.
- 경고 컬러 사용 여부, 남은 시간 표시, 주문서 순서를 매장에 맞게 커스터마이징 가능.
- 가로형(한 번에 한 주문씩 순차 처리) / 세로형(여러 주문을 한눈에 보고 동시 조리) 뷰를 매장 특성에 맞게 선택 가능.

#### BoardBite POS에 적용할 내용
- "경고 컬러(잔여시간 임박 시 색상 변경)" 개념을 지연 표시 기준으로 채택.
- 세로형(여러 주문 동시 조망) 레이아웃 채택 — 보드게임 카페 특성상 여러 테이블을 동시에 조리.
- 주방 섹션 개념은 참고하되, 기본은 단일 스테이션으로 설계하고 확장 가능하게만 열어둔다.

#### 적용하지 않을 내용
가로형(순차 1건 처리) 뷰는 채택하지 않음 — 부스는 대기 회전이 빨라 여러 주문 동시 관리가 필요.

#### 이유
행사장 특성상(짧은 시간에 많은 테이블 회전) 여러 주문을 동시에 조망할 수 있는 화면이 필수적이며, 순차 처리형 UI는 처리 속도 병목을 유발할 수 있다.

---

### 상용 KDS 일반 원칙 - 경과시간/색상 강조/스테이션 라우팅/Bump/READY-SERVED (해외 벤더 자료 종합)

- 조사일: 2026-09-11
- URL: 다수 벤더 블로그 종합 — 대표: https://gotab.com/products/kitchen-display-system-kds , https://volcora.com/blogs/news/kitchen-display-system-guide , https://delivety.com/blog/kitchen-display-system-guide-what-is-a-kds , https://kwickos.com/blog/best-kitchen-display-system-kds-2026.html
- 종류: 기술문서/사례 (여러 벤더 블로그 취합, 개별 원문 미열람)
- 신뢰도: 중간 (여러 독립 벤더가 유사하게 서술하는 공통 관행이라 "업계 관행" 수준으로 신뢰, 세부 수치는 벤더별 상이)

#### 핵심 내용
- 경과시간 표시: 각 티켓에 조리 경과시간을 표시하고 목표 조리시간 대비 지연 여부를 자동 판단.
- 색상 강조: "흰색/초록(신규) → 노랑(경과 임박) → 빨강(지연/초과)" 3단계 색상 신호가 업계 공통 관행. 색상 변경 외에 텍스트/굵은 글씨/깜빡임 병행 강조도 흔함.
- Bump 개념: 조리 완료 항목/티켓을 "밀어내는(bump)" 액션으로 완료 처리(터치 또는 물리적 bump bar). Bump 후에도 "리콜(recall)"로 되돌릴 수 있어야 실수 대응 가능.
- 스테이션 라우팅: 주문을 항목 단위로 분해해 담당 스테이션 화면에만 표시, 모든 항목 완료 시 익스포(expo) 화면에서 전체 완료로 취합(여러 스테이션 완료 타이밍 동기화가 핵심 목적).
- READY vs SERVED 구분: "조리 완료"와 "고객에게 실제 전달"을 별도 이벤트로 구분해 추적하는 것이 잘 설계된 시스템의 특징.
- 동일 메뉴 다수 주문 시 색상/굵게 강조하는 UX 요구가 실사용자 피드백에서 반복 언급.

#### BoardBite POS에 적용할 내용
- 3단계 색상 신호(정상/임박/지연) 원칙 채택 — 목표 조리시간 대비 80% 경과 시 노랑, 100% 초과 시 빨강 + "지연" 텍스트 배지 병기(색상만으로 구분하지 않음, 접근성 고려).
- 완료 처리(bump) 후 되돌리기(실수 취소) 기능 반영.
- 동일 메뉴 다수 주문 시 수량 강조 표시 반영.
- READY(조리완료)와 SERVED(테이블 전달완료)를 별도 상태로 구분 — 진행요원이 테이블까지 서빙하므로 실무적으로 유의미.

#### 적용하지 않을 내용
물리적 bump bar 하드웨어 도입 제외(터치스크린만 사용). 다중 스테이션 라우팅(물리적으로 분리된 여러 화면)은 기본 범위에서 제외.

#### 이유
행사성 소규모 운영이라 하드웨어 확장은 과설계이며 예산·설치 복잡도 대비 이득이 적다. 색상/텍스트 병행 강조, READY/SERVED 구분, 수량 강조는 구현 비용이 낮으면서 조리 실수를 줄이는 핵심 UX이므로 채택한다.

---

### KDS 항목별 완료(Item Mode) vs 티켓 전체 완료(Order Mode) 사례

- 조사일: 2026-09-11
- URL: 다수 출처 종합 — 대표: https://www.menusifu.com/blog/best-kitchen-display-systems-for-restaurants , https://pos.toasttab.com/blog/on-the-line/kitchen-display-system
- 종류: 사례 (벤더 소개 글, 검색 요약 기반)
- 신뢰도: 중간 (벤더 마케팅 자료, 원문 미열람)

#### 핵심 내용
- 일부 KDS는 "Order Mode"(주문 전체 단위 완료)와 "Item Mode"(개별 메뉴 항목 단위 완료)를 매장 운영 방식에 따라 전환 지원.
- 동일 메뉴를 여러 테이블이 동시에 주문한 경우 그룹핑해서 배치 조리(batch prep)하도록 돕는 기능도 언급.
- 서버가 바코드/스캔 등으로 "이 항목을 손님에게 전달했다(served)"를 기록하는 사례가 있어 주방 완료와 고객 전달 완료가 별도 워크플로우로 취급됨.

#### BoardBite POS에 적용할 내용
- 기본은 "티켓(주문) 전체 완료" 모드로 채택하되, 향후 메뉴가 다양해지고 조리시간 편차가 커질 경우를 대비해 "항목별 완료" 모드로 확장 가능하도록 주문 항목별 상태 필드를 데이터 모델에 미리 반영(요구사항의 "품목별 완료/전체 완료" 요구와 일치).
- 동일 메뉴 합산 수량을 KDS에 요약 표시하는 기능은 후순위로 고려.

#### 적용하지 않을 내용
바코드 스캔 기반 서빙 확인은 채택하지 않음 — 부스 규모에 비해 과한 장비/프로세스.

#### 이유
초기 버전은 단순함을 우선하되, 데이터 모델 자체는 항목 단위 상태를 저장할 수 있게 설계해두면 추후 메뉴/조리 파트가 분리될 때 재설계 비용을 줄일 수 있다.

---

### POS/KDS 네트워크 재연결 및 오프라인 동기화 처리 원칙

- 조사일: 2026-09-11
- URL: 다수 출처 종합 — 대표: https://taptouchpos.com/ko/blogs/how-to-keep-your-restaurant-running-when-the-internet-goes-down/ , https://www.szzcs.com/ko/blog/what-is-an-offline-pos-system.html , https://okpos.gitbook.io/okpos/table_qr_pay/kds-kitchen-display-system
- 종류: 기술문서/사례 (벤더 블로그 종합, 검색 요약 기반)
- 신뢰도: 중간 (벤더별 구현 수준 차이가 크다고 스스로 명시 — 일반 원칙 수준으로만 신뢰)

#### 핵심 내용
- 우수한 오프라인 지원 POS/KDS는 연결 끊김 시 주문 데이터를 로컬에 임시 저장하고, 재연결되면 발생 순서대로 자동 재전송하여 수동 재입력이 불필요.
- 재연결 시 중복 기록/충돌 방지(동일 주문이 두 번 반영되지 않도록)가 핵심 과제.
- 로컬 네트워크(LAN)만으로 POS-KDS 간 통신이 되는 구조가 인터넷 장애에 강하다는 사례(TapTouch, OKPOS의 IP/PORT 직접 연결 방식) 소개.

#### BoardBite POS에 적용할 내용
- 행사장(체육관/강당 등)은 인터넷 회선이 불안정할 수 있으므로, 카운터 POS ↔ 주방 KDS 간 통신을 가능하면 로컬 네트워크(같은 Wi-Fi/LAN) 기반으로 구성하고 외부 인터넷 의존도를 최소화.
- 클라이언트(KDS/POS) 측 임시 큐잉 + 재연결 시 순서대로 재동기화 + idempotent 처리(주문 ID 기반 dedup) 원칙 적용.
- 연결 끊김 상태를 KDS/POS 화면 상단 배너로 명확히 표시.

#### 적용하지 않을 내용
완전한 분산 오프라인 결제(카드 오프라인 승인 등)는 범위 밖 — 결제 수단이 단순(현금/카드 수기 기록)하므로 복잡한 오프라인 결제 동기화는 과설계.

#### 이유
행사장 네트워크 환경은 상용 매장보다 불안정할 가능성이 높아(임시 Wi-Fi, 다수 기기 동시 접속) 재연결 복원력은 필수 요건이나, 카드결제 오프라인 승인 같은 고난도 기능은 이번 프로젝트 범위와 맞지 않는다.

#### 종합 제안 (Agent B)

BoardBite POS의 KDS는 [접수대기]/[조리중]/[완료] 3탭 구조를 기본으로 하고, 배달앱 특유의 "배달중" 탭이나 라이더 관련 요소는 제외한다. 주문 카드에는 테이블 번호, 메뉴/수량, 접수 경과시간, 특이사항을 표시하고, 조리 목표시간 대비 진행률을 3단계 색상(정상/임박/지연)으로 표시하되 색상만이 아니라 "지연" 텍스트 배지를 병기해 접근성을 확보한다. 지연 기준은 매장에서 설정 가능한 목표 조리시간(예: 5~10분) 대비 경과 비율로 정의하며, 임박(예: 80% 경과)과 초과(100% 이상)를 구분한다. 완료 처리는 조리완료(READY)와 테이블 전달완료(SERVED)를 별도 상태로 분리해 진행요원의 서빙 누락을 방지한다. 알림음은 신규 주문 접수 시 1회, 목표 조리시간 초과(지연 전환) 시 별도 경고음으로 구분해 재생하고, 동일 메뉴 다중 주문 시 수량을 굵게 강조 표시한다. 네트워크는 가능한 로컬 LAN 기반으로 POS-KDS를 연결하고, 재연결 시 주문 ID 기반 중복 방지 동기화 로직을 반드시 갖춘다.

---

# Agent D — 보안 위협 조사 (OWASP)

### IDOR/BOLA 및 테이블 접근 위협

- 조사일: 2026-09-11
- URL: https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/ , https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html , https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/
- 종류: 공식문서(OWASP API Security Top 10) / OWASP Cheat Sheet
- 신뢰도: 높음 (OWASP 공식 1차 자료, API1:2023 1위 항목)

#### 핵심 내용
OWASP API Security Top 10에서 BOLA(Broken Object Level Authorization)는 2019·2023 두 판 모두 API 위협 1위이며, 서버가 클라이언트 상태를 제대로 추적하지 않고 객체 ID만으로 접근을 허용할 때 발생한다. 실제 사례로 Parler는 게시물 ID가 순차적이어서 ID를 하나씩 바꾸며 무단 접근/데이터 수집이 가능했고, rate limit이 없어 자동화 스크립트로 대량 탈취가 이루어졌다 — BoardBite의 `/table/7` → `/table/8` 시나리오와 정확히 동일한 패턴이다. OWASP는 "로그인 세션의 사용자 ID와 요청 파라미터의 ID를 비교하는 것만으로는 충분하지 않다"고 명시하며, ID를 받는 모든 엔드포인트에서 요청마다 객체 단위 권한 검사를 수행해야 한다고 권고한다. IDOR Prevention Cheat Sheet는 근본 대책으로 "쿼리 자체를 현재 세션의 권한 범위로 스코프"할 것(`WHERE table_session_id = :current_session`)을 primary control로, 간접 참조 맵이나 예측 불가능한 식별자(UUID)는 defense-in-depth 보조 수단으로 규정한다(식별자 난독화만으로는 IDOR을 막지 못함).

#### BoardBite POS에 적용할 내용
- 테이블 식별자를 순차 정수(`/table/7`)로 노출하지 않는다. QR/NFC에는 테이블별 비추측성 세션 토큰(32바이트 이상 CSPRNG 기반 opaque token)을 URL에 발급하고, 내부 테이블 번호는 서버-DB 매핑으로만 관리한다.
- 모든 주문/결제/조회 API는 요청 파라미터의 table_id가 아니라 토큰에서 유도된 세션의 table_id를 기준으로 쿼리를 스코프한다. 클라이언트가 body/URL에 넣은 table_id는 신뢰하지 않고 서버 측 세션 값과 항상 재검증한다.
- 테이블 세션 토큰은 테이블마다, 그리고 CLOSED/정산 완료 시마다 회전(rotate)한다.
- 토큰 조회/주문 API에 IP+토큰 단위 rate limit(예: 분당 30회) 적용해 무차별 테이블 열거(enumeration) 방지.
- 관리자/직원 화면의 테이블 목록 API는 손님용 API와 완전히 분리된 라우트/미들웨어 체인을 사용(공용 access-control 체크를 1곳에 모아 재사용).

#### 적용하지 않을 내용
식별자 암호화(encrypted ID) 방식은 도입하지 않는다.

#### 이유
OWASP Cheat Sheet가 "암호화 방식의 식별자 난독화는 안전하게 구현하기 어렵다"고 명시적으로 경고하며, opaque random token + 서버측 스코프 쿼리만으로 동일한 보안 목표를 더 단순하고 검증하기 쉬운 방식으로 달성할 수 있기 때문이다.

---

### 세션/인증 관련 위협 (이전 손님 세션 재사용, brute force, 세션 탈취/고정)

- 조사일: 2026-09-11
- URL: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html , https://owasp.org/www-community/attacks/Session_fixation , https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html , https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- 종류: OWASP Cheat Sheet (공식)
- 신뢰도: 높음

#### 핵심 내용
Session Management Cheat Sheet는 세션 고정(fixation)을 "공격자가 유효한 세션 ID를 미리 확보해 피해자에게 심어두고, 피해자가 그 ID로 로그인하면 탈취하는 공격"으로 정의하며, 핵심 대응은 로그인·비밀번호 변경·권한/역할 전환 시점마다 세션 ID를 반드시 재발급(regenerate)하는 것이다. Secure/HttpOnly 쿠키 속성 및 TLS를 병행해야 한다. Credential Stuffing / Authentication Cheat Sheet는 실패 5~10회 기준 임계값 후 시간 기반 잠금, IP 단위와 계정 단위 rate limit을 함께 적용(둘 중 하나만 하면 우회 가능)할 것을 권고하며, 영구 잠금은 DoS 악용 위험이 있으므로 분 단위의 점진적 지연·임시 잠금을 권장한다.

#### BoardBite POS에 적용할 내용
- 손님(테이블) 세션: 테이블이 CLOSED/정산 처리되는 즉시 서버에서 해당 테이블 세션 토큰을 무효화하고, 만료된 토큰으로의 모든 요청은 403 + 안내 메시지. 새 손님이 같은 테이블에 앉으면 직원이 "테이블 재오픈" 액션을 눌러야만 새 토큰이 발급되도록 하여 이전 손님의 재진입을 차단.
- 브라우저 뒤로가기/캐시로 이전 화면이 보이더라도 실제 API 호출 시 서버가 토큰 유효성을 매번 재검증(`Cache-Control: no-store` 병행).
- 직원 로그인: bcrypt/argon2 해시 + 계정당 실패 5회 후 5분 잠금, 15회/1시간 초과 시 IP 단위 추가 제한. 로그인 성공 시 세션 재발급, 역할 변경 시에도 재발급.
- 세션 쿠키에 `HttpOnly; Secure; SameSite=Lax(또는 Strict); Path=/`, 만료시간은 근무 교대 주기(예: 8~12시간) 기준으로 짧게.
- 실패 로그인/잠금 이벤트를 감사 로그에 기록.

#### 적용하지 않을 내용
전체 사용자 대상 MFA(OTP 등) 도입은 1차 범위에서 제외.

#### 이유
학생 부스 운영 특성상 직원 계정 수가 적고 물리적으로 관리 가능한 환경이라, MFA보다는 강력한 rate limit + 짧은 세션 만료 + 로그 모니터링이 비용 대비 효과가 크다. 관리자 권한 계정에는 추후 MFA 도입을 권장 사항으로 남긴다.

---

### 웹 기본 보안 (XSS / CSRF / SQL Injection)

- 조사일: 2026-09-11
- URL: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html , https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html , https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
- 종류: OWASP Cheat Sheet (공식)
- 신뢰도: 높음

#### 핵심 내용
- XSS: 최우선 방어는 프레임워크 보안 기능 + 출력 인코딩(output encoding) + HTML sanitization이며, CSP는 "주 방어수단이 아닌 defense-in-depth 보조 계층"이다. 사용자 입력을 `innerHTML` 등 위험 sink에 넣지 말고 컨텍스트별 인코딩을 사용해야 한다.
- CSRF: Stateful 서버는 synchronizer token pattern, stateless/API 서버는 커스텀 요청 헤더 방식을 권장. SameSite 쿠키만으로는 불충분하며 반드시 CSRF 토큰과 병행해야 한다.
- SQL Injection: 1차 방어는 파라미터화된 쿼리/ORM 사용이며, ORM을 쓰더라도 raw query/문자열 결합은 동일하게 취약하므로 코드리뷰로 게이트해야 한다. 문자열 escape는 "최후의 수단"이며 보장되지 않는다.

#### BoardBite POS에 적용할 내용
- 고객 "요청사항/메모" 필드는 저장 시 원문 유지, 출력(KDS/POS 화면) 시점에 프레임워크 기본 텍스트 바인딩으로 이스케이프(`dangerouslySetInnerHTML`/`v-html` 절대 금지).
- 메모 필드 길이 제한(예: 200자).
- CSP 헤더 예시: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`
- 세션 쿠키 기반 인증 사용 시 모든 상태 변경 API에 CSRF 토큰(`X-CSRF-Token`) 필수 검증 + `SameSite=Lax` 병행. 손님용 테이블 API는 커스텀 헤더(`X-Table-Token`) 요구만으로도 단순 폼 기반 CSRF 차단 가능.
- DB 접근은 ORM 쿼리 빌더만 사용하고, raw SQL/문자열 결합 SQL은 코드리뷰 체크리스트에서 금지 항목으로 지정. DB 계정은 애플리케이션 전용 최소권한 계정 사용.

#### 적용하지 않을 내용
사용자 입력에 대한 공격적 서버측 HTML 태그 strip(모든 특수문자 제거)은 적용하지 않는다.

#### 이유
과도한 입력 필터링은 정상적인 한글/특수문자 요청사항을 훼손할 수 있고, OWASP도 입력 필터링보다 출력 인코딩을 핵심 방어로 권장하기 때문이다.

---

### Role Escalation 및 관리자 API 직접 호출 위협

- 조사일: 2026-09-11
- URL: https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/ , https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/
- 종류: 공식문서(OWASP Top 10 / API Security Top 10)
- 신뢰도: 높음

#### 핵심 내용
OWASP Top 10 A01은 테스트된 애플리케이션의 94%에서 어떤 형태로든 broken access control이 발견되었다고 보고하며, 대표 시나리오로 "URL/파라미터 조작으로 관리자 페이지 강제 접근", "JWT의 role 필드 변조", "프론트엔드에서만 숨겨진 기능을 devtools로 직접 실행" 등을 제시한다. API Security Top 10은 이를 BFLA(Broken Function Level Authorization, 함수/엔드포인트 단위 권한 부재)로 구분한다 — POS 직원 계정이 관리자 전용 API를 직접 호출하는 것이 전형적 BFLA다. 핵심 원칙은 "기본 거부", "접근 제어를 한 곳(미들웨어)에서 구현해 전체 재사용", "프론트엔드 숨김에 의존하지 않고 서버가 매 요청마다 역할을 검증"이다.

#### BoardBite POS에 적용할 내용
- 역할(FRONT/POS/SERVING/ADMIN)을 서버 세션에만 저장하고, 클라이언트가 보내는 role 클레임은 신뢰하지 않는다. 역할이 실시간으로 바뀔 수 있으므로 캐시된 role만 믿지 않고 DB 대조.
- 라우트 단위가 아니라 미들웨어 단위로 RBAC을 중앙집중화: `requireRole('admin')` 미들웨어를 관리자 API 라우터 전체에 일괄 적용.
- 관리자 전용 엔드포인트는 별도 URL prefix(`/api/admin/*`)로 분리하고, "POS 역할 토큰으로 /api/admin/* 호출 시 전부 403"을 회귀 테스트로 고정.
- 프론트엔드에서 관리자 메뉴를 숨기는 것과 무관하게 백엔드가 항상 재검증하도록 코드리뷰 체크리스트에 명시.

#### 적용하지 않을 내용
세분화된 속성 기반 접근제어(ABAC, 동적 정책 엔진) 도입은 하지 않는다.

#### 이유
BoardBite는 역할 종류가 적고 고정적이므로 단순 RBAC 미들웨어로 충분하며, ABAC 엔진 도입은 학교 부스 운영 규모에 비해 과도한 복잡도를 추가한다.

---

### 주문/결제 무결성 및 동시성 위협 (가격 조작·중복 주문·Replay·결제 동시성)

- 조사일: 2026-09-11
- URL: https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html , https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html , https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/ (API4:2023 Unrestricted Resource Consumption 포함), Stripe 등 업계 idempotency key 관행
- 종류: OWASP Cheat Sheet(공식) + 업계 표준 관행
- 신뢰도: 높음(OWASP), 중~높음(업계 관행)

#### 핵심 내용
- 클라이언트 가격/수량 조작: 클라이언트가 보낸 가격·합계는 절대 신뢰해서는 안 되며, 서버가 메뉴 ID로 DB의 현재 가격을 조회해 재계산해야 한다는 것이 표준 원칙(가격을 클라이언트에서 받는 설계 자체가 Insecure Design).
- Replay 공격: 요청에 nonce + timestamp를 포함하고, 서버가 중복 nonce 또는 허용 시간창(예: 5분)을 벗어난 요청을 거부할 것을 권고. 모든 거래(주문/결제)의 인가값은 매번 고유해야 한다.
- 더블탭 중복 주문 / 결제 중복 처리 / 동시 부분결제 race condition: 업계 표준 관행은 클라이언트가 생성한 idempotency key를 요청 헤더에 담아 서버가 "키+DB unique constraint 기반 원자적 삽입"으로 처리하는 것 — naive한 "조회 후 삽입"은 두 요청이 동시에 들어오면 여전히 레이스 컨디션이 발생하므로, DB unique constraint 또는 원자적 연산이 반드시 필요하다.

#### BoardBite POS에 적용할 내용
- 가격/합계: 주문 생성 API는 클라이언트로부터 메뉴 ID + 수량 + 옵션ID만 받고, 단가·옵션가·합계는 서버가 DB에서 조회해 재계산. 클라이언트가 보낸 price/total 필드는 무시.
- 더블탭 중복 주문 방지: 클라이언트 생성 UUID(`Idempotency-Key` 헤더)를 주문 생성 요청에 포함, `(table_session_id, idempotency_key)` 복합 UNIQUE 제약으로 DB 레벨에서 원자적으로 중복 차단. 동일 키 재요청 시 기존 주문 응답을 그대로 반환.
- 결제 확정 API도 Idempotency-Key 필수화. 결제 상태 전이는 DB 트랜잭션 + 조건부 UPDATE(`WHERE paid_amount + :amt <= total_amount`)로 "초과결제 불가"를 DB 레벨에서 강제.
- CLOSED 테이블 주문 시도: 주문 생성 API 최상단에서 `table_session.status == 'OPEN'` 확인을 공통 미들웨어로 강제, CLOSED/정산완료 상태면 409 반환.

#### 적용하지 않을 내용
분산 락(Redis 기반 distributed lock) 도입은 하지 않는다.

#### 이유
현재 규모(단일 서버, 단일 DB 인스턴스 가정)에서는 RDBMS의 UNIQUE 제약 + 트랜잭션 격리 수준만으로 레이스 컨디션을 원자적으로 차단할 수 있어, Redis 락 등 추가 인프라 없이도 idempotency 목표를 달성할 수 있기 때문이다. 다중 서버로 확장 시 재검토 필요.

---

### Audit Log Tampering 위협

- 조사일: 2026-09-11
- URL: https://owasp.org/Top10/2021/A09_2021-Security_Logging_and_Monitoring_Failures/ , https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- 종류: 공식문서(OWASP Top 10 A09) + OWASP Cheat Sheet
- 신뢰도: 높음

#### 핵심 내용
OWASP Top 10 A09는 "모든 트랜잭션에 대해 append-only 데이터베이스 테이블 등 무결성 통제가 적용된 감사 추적을 갖추어 변조·삭제를 방지하라"고 명시한다. Logging Cheat Sheet는 로그 데이터를 "위조·변조·재전송될 수 있는 신뢰할 수 없는 데이터로 취급"하고, 변조/무단 접근/삭제를 탐지하는 프로세스를 마련하며, 암호학적 해시 함수로 로그 항목의 무결성을 검증하는 기법을 제시한다.

#### BoardBite POS에 적용할 내용
- 감사 로그(주문 생성/수정/취소, 결제 처리, 정산 마감, 관리자 설정 변경, 로그인 실패/성공, 역할 변경)를 별도의 append-only 테이블(애플리케이션 DB 계정에서 UPDATE/DELETE 권한 원천 배제)에 기록.
- 각 로그 레코드에 이전 레코드 해시를 포함한 해시 체인(`record_hash = SHA256(prev_hash + payload)`)을 적용해 중간 레코드 삭제/변조 시 체인이 끊겨 탐지 가능하게 한다.
- 정기적으로(예: 일 1회) 로그를 별도 저장소로 백업.
- 결제/정산 관련 로그는 최소 보관 기간을 정해 정산 분쟁 대응 근거로 활용.

#### 적용하지 않을 내용
외부 SIEM이나 실시간 이상탐지 알림 시스템 도입은 하지 않는다.

#### 이유
단발성/단기간 운영되는 소규모 시스템 특성상 별도 SIEM 구축 비용 대비 효과가 낮다. append-only 테이블 + 해시체인 + 백업만으로 "사후 변조 탐지"라는 핵심 목표는 충분히 달성 가능하다.

---

### Public GitHub Repo Secret 관리 위협

- 조사일: 2026-09-11
- URL: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- 종류: OWASP Cheat Sheet (공식) + 업계 사례(GitGuardian/Snyk 시크릿 유출 통계)
- 신뢰도: 높음(OWASP), 중(통계는 벤더 리포트지만 업계에서 널리 인용됨)

#### 핵심 내용
OWASP Secrets Management Cheat Sheet는 "git rm으로 파일을 지워도 git의 append-only 데이터 모델 특성상 히스토리에는 영구히 남는다"는 점을 강조한다. 권장 대응은 (1) pre-commit 단계 시크릿 스캐너(Gitleaks, ggshield, TruffleHog)로 커밋 전 차단, (2) client-side hook은 `--no-verify`로 우회 가능하므로 서버측/CI 단계 스캔 병행, (3) fork된 PR의 워크플로에서 시크릿 접근 차단.

#### BoardBite POS에 적용할 내용
- `.env`, DB 접속 정보, 세션 시크릿 등 모든 시크릿은 저장소에 절대 커밋하지 않고 `.env.example`(값 없는 키 이름만)만 커밋. `.gitignore`에 `.env*` 명시(완료).
- GitHub 저장소에 Secret Scanning + Push Protection(Public repo 기본 무료 제공)을 활성화.
- CI에 Gitleaks 또는 TruffleHog를 GitHub Actions 워크플로에 추가(pre-commit은 우회 가능하므로 CI 단계가 최종 방어선).
- 과거 커밋 히스토리에 이미 시크릿이 들어간 이력이 있다면 히스토리 재작성보다 시크릿 자체를 즉시 회전(rotate)하는 것이 우선.

#### 적용하지 않을 내용
HashiCorp Vault 등 중앙 시크릿 매니저 플랫폼 도입은 하지 않는다.

#### 이유
단일 서버/단일 DB로 운영되는 소규모 프로젝트이며 시크릿 개수도 적어, 중앙 시크릿 매니저의 운영 복잡도가 실제 위협 감소 효과 대비 과도하다. `.gitignore` + Secret Scanning + 환경변수 주입 + 회전 프로세스만으로 핵심 위협을 충분히 방어할 수 있다.

#### 종합 제안 (Agent D) — BoardBite POS 보안 체크리스트

**인증/세션(직원 로그인)**
- 비밀번호 bcrypt/argon2 해싱, 로그인 실패 5~10회 시 계정 단위 임시 잠금 + IP rate limit 병행
- 로그인 성공/역할 변경 시 세션 재발급, 쿠키 `HttpOnly; Secure; SameSite=Lax`, 짧은 만료
- 관리자 API는 별도 RBAC 미들웨어로 중앙 검증

**테이블 토큰(손님 QR/NFC 세션)**
- 비추측성 opaque 토큰, 서버측 세션 스코프 쿼리, CLOSED/정산 시 즉시 무효화 및 재오픈 시 신규 발급
- 토큰 기반 요청 rate limit, CLOSED 상태 주문 시도는 공통 미들웨어에서 409 즉시 차단

**주문 생성**
- 서버가 DB 현재가로 가격 재계산, 메모 필드는 출력 시 이스케이프
- Idempotency-Key + DB UNIQUE 제약으로 더블탭/재전송 중복 주문 원자적 차단
- CSRF 토큰/커스텀 헤더 + SameSite 쿠키 병행

**결제/정산**
- 결제 확정 API에도 Idempotency-Key 필수, 부분결제 합계 초과 불가를 SQL 조건부 UPDATE로 DB 레벨 강제
- 결제 상태 전이는 트랜잭션 + 행 잠금으로 원자적 처리
- 정산 감사 로그는 append-only + 해시체인

**공통 웹 보안**
- 전체 DB 접근은 ORM 쿼리빌더만 사용, raw SQL 문자열 결합 금지
- CSP/X-Content-Type-Options/X-Frame-Options 등 보안 헤더, HTTPS 강제(HSTS)

**Public GitHub 저장소 운영**
- `.env` 등 시크릿 `.gitignore` 처리(완료), Secret Scanning + Push Protection 활성화
- CI에 Gitleaks/TruffleHog 통합, 유출 이력 발견 시 즉시 시크릿 회전

---

# Agent A — OKPOS 후불형 POS 조사

### OKPOS 가이드북 전체 구조 및 서비스 개요

- 조사일: 2026-09-11
- URL: https://okpos.gitbook.io/okpos-guide/
- 종류: 공식문서 (GitBook 기반 사용자 가이드 최상위 목차 페이지)
- 신뢰도: 상 (OKPOS 공식 GitBook 도메인에서 직접 확인)

#### 핵심 내용
OKPOS 가이드북 최상위 목차에는 "포스(OKPOS PLUS)사용법", "QR오더", "오늘얼마" 등의 대분류가 존재한다. OKPOS는 2008년 설립되어 주문·결제 처리 POS를 중심으로 키오스크·배달앱 연동·QR오더·CRM 등으로 확장한 국내 대형 POS 업체다. "QR오더"와 태블릿 기반 "테이블오더"(22개 제휴사 연동)를 별도 카테고리로 구분해, QR오더는 자체 서비스로 직접 제공하고 태블릿형 테이블오더는 외부 제휴사 솔루션을 POS와 연동하는 구조다.

#### BoardBite POS에 적용할 내용
- "포스(정산 담당 기기)"와 "테이블 주문 입력 수단(QR/NFC)"을 개념적으로 분리하는 구조 — FRONT/POS(정산)와 학생 개인 기기(NFC/QR 모바일 주문)를 별도 역할로 설계하고, 두 흐름이 같은 테이블/주문 데이터를 공유하도록 한다.
- 매출/정산 조회 기능("오늘얼마")을 정산 화면과 별도의 대시보드로 분리해 운영진이 실시간 매출을 조회할 수 있게 한다(ADMIN 대시보드).

#### 적용하지 않을 내용
OKPOS의 22개 제휴 테이블오더사 연동 같은 멀티 벤더 연동 구조는 불필요하다.

#### 이유
BoardBite POS는 단일 학교 행사용 자체 시스템이라 외부 벤더 연동은 과설계이지만, "정산 기기 vs 주문 입력 기기"의 역할 분리와 "실시간 매출 조회" 개념은 소규모 운영에도 유용하다.

---

### OKPOS 결제 화면 - 복합결제("나눠서 복합결제하기")

- 조사일: 2026-09-11
- URL: https://okpos.gitbook.io/okpos/undefined-5/undefined/payment/mixed_media (검색 스니펫으로 확인, WebFetch 직접 접근은 404 — GitBook 슬러그 변경 추정)
- 종류: 공식문서 (도움말 페이지, 검색엔진 캐시 스니펫)
- 신뢰도: 중 (본문 전체가 아닌 검색 스니펫 기반)

#### 핵심 내용
복합결제(나눠서 결제하기) 절차: "복합결제를 누름 → 전체 결제 금액 중 한 가지 결제수단으로 처리할 금액을 입력". 결제 관련 챕터는 "현금 결제", "카드 결제", "나눠서 복합결제", "더치페이 결제", "할인 결제", "외상결제/외상관리" 등으로 병렬 구성된다. 복합결제 시 결제수단별 영수증 분리 출력 설정("개별영수증 출력")이 존재한다.

#### BoardBite POS에 적용할 내용
- "총 결제금액 중 일부를 특정 수단으로 지정 → 잔액을 다른 수단으로 처리"하는 흐름을 복합결제/부분결제 하나의 "결제 시도(Payment)" 레코드로 누적하고, 남은 미수금을 항상 화면에 노출한다.
- 결제수단별 영수증 분리 기록 개념을 참고해 결제수단별로 별도의 Payment 레코드를 남긴다.

#### 적용하지 않을 내용
POS 단말 자체에 결제수단 버튼을 웹 관리자에서 사전 등록해야 하는 하드웨어 종속적 설정 구조는 적용하지 않는다.

#### 이유
BoardBite는 실물 VAN/PG 연동이 없고 현금/카드/기타는 기록만 하는 방식이므로, 소프트웨어상의 자유 입력 방식이 더 적합하다.

---

### OKPOS 더치페이 결제하기

- 조사일: 2026-09-11
- URL: https://okpos.gitbook.io/okpos/undefined-5/undefined/payment/per_person (검색 스니펫 기반, WebFetch 직접 접근은 404)
- 종류: 공식문서 (도움말 페이지, 검색 스니펫 기반)
- 신뢰도: 중

#### 핵심 내용
OKPOS 더치페이는 (1) 상품별 방식, (2) 고객수별(1/N) 방식 두 가지로 나뉜다. 상품별 방식은 결제화면 → 더치페이 → 결제할 상품 선택 → 개별 결제를 반복 진행 → 영수증관리에서 결제 건수별 확인. 고객수별(1/N)은 "고객수" 탭에서 총액을 인원수로 나눈다(UI 탭이 분리됨).

#### BoardBite POS에 적용할 내용
- "품목 단위로 결제 대상을 선택해 개별 결제를 반복"하는 상품별 더치페이는 BoardBite의 "상품별결제" 요구사항과 정확히 동일한 개념이므로, 각 주문 항목이 독립적으로 결제완료/미결제 수량을 가질 수 있게 설계한다.
- "인원수로 나누기"와 "메뉴 골라서 결제"를 서로 다른 진입점으로 분리하는 UX 원칙을 참고한다.
- 여러 번의 결제를 하나의 테이블에 누적 기록하고 각 결제 건을 조회 가능하게 하는 이력 구조를 만든다.

#### 적용하지 않을 내용
없음 — 더치페이 개념 자체는 요구사항과 잘 맞아 원칙을 그대로 참고한다.

#### 이유
BoardBite 요구사항(부분결제/더치페이/상품별결제)이 OKPOS 더치페이 기능과 목적이 거의 동일하므로 원칙만 가져오고 화면/버튼 명칭은 자체 설계한다.

---

### OKPOS QR오더&페이 서비스 (주문 유형 및 결제 흐름)

- 조사일: 2026-09-11
- URL: https://tablepay.okpos.co.kr/ , https://qr.okpos.co.kr/ (WebFetch는 JS 렌더링/403 문제로 실패, WebSearch 스니펫으로 확인)
- 종류: 공식 서비스 소개 페이지 (홍보성 콘텐츠 포함)
- 신뢰도: 중 (검색엔진 스니펫 기반 교차 확인)

#### 핵심 내용
OKPOS QR오더&페이는 주문 유형을 "주문전용, 선결제 주문, 선불 픽업, 후결제 주문, 결제 전용" 5가지로 구분한다. 선불형과 후불형을 모두 지원하며 PG 연동은 선택 사항이다. 고객 스마트폰 데이터로 주문이 이루어져 매장 와이파이가 필요 없지만, POS 단말은 인터넷망이 필요하다. 간편결제(카카오페이 등) 사용 시 POS 화면에 "결제완료"가 표시되지 않으면 자동 취소되는 실무 이슈가 있다.

#### BoardBite POS에 적용할 내용
- "후결제 주문" 유형이 BoardBite의 "테이블 OPEN 후 모바일로 주문 누적, 나갈 때 일괄 정산" 요구사항과 정확히 대응하므로 이를 기본 모드로 채택한다.
- 결제 상태(대기/완료/취소)를 명확히 구분해 표시하고 애매한 상태를 방치하지 않는 UX 원칙을 반영한다.

#### 적용하지 않을 내용
PG 결제 연동, 수수료 체계는 적용하지 않는다 — BoardBite는 실제 금융 결제망을 사용하지 않는 기록형 정산이기 때문이다. "결제 전용" 모드는 우선순위가 낮다.

#### 이유
BoardBite POS는 실제 PG/카드 매입이 아니라 학교 행사 내 기록 기반 정산이므로 수수료·PG 연동은 불필요하다. "후불형 주문-정산 분리"와 "결제 상태의 명확한 구분" 원칙만 유효하다.

---

### OKPOS 자주 묻는 질문(FAQ) - 테이블/취소/영수증 실무 이슈

- 조사일: 2026-09-11
- URL: https://okpos.gitbook.io/okpos/faqs
- 종류: 공식문서 (FAQ, 실제 본문 직접 확인)
- 신뢰도: 상 (WebFetch로 본문 확인)

#### 핵심 내용
테이블이 겹쳐 보이는 버그(Q12)의 해결책은 "주문 취소 후 테이블 재조정" — 테이블 상태 데이터가 꼬일 수 있음을 시사. 24시간 매장은 테이블에 주문이 남은 채로 마감 가능(Q17) — 영업일 마감과 테이블 오픈 상태가 독립적으로 처리됨. 취소된 주문은 "빨간 빗금" 표시로 구분(Q10)되어 재주문 시 주방 출력을 하지 않는 등 오처리를 방지한다. 복합결제 시 결제수단별 영수증 분리 출력 옵션(Q7)이 존재하고, 현금 매출과 현금영수증 매출을 구분 조회하는 기능(Q19)이 있다.

#### BoardBite POS에 적용할 내용
- 취소된 주문 항목을 취소선/회색 처리 등으로 명확히 시각 구분해 정상 항목과 혼동되지 않게 한다.
- "행사 마감"과 "개별 테이블 오픈/클로즈 상태"를 독립적인 상태값으로 분리 설계 — 행사 종료 시점에도 미정산 테이블을 예외 없이 처리할 수 있는 상태 모델 필요.
- 결제수단과는 별도로 "정산 완료 여부" 등의 메타데이터를 둘 수 있다.

#### 적용하지 않을 내용
테이블 좌표 겹침 버그 자체는 참고할 필요 없으나, "상태 동기화 문제가 실제 발생할 수 있다"는 리스크 인식만 참고한다.

#### 이유
FAQ는 실제 매장의 엣지 케이스를 보여주므로, 유사한 상태 불일치 리스크를 상태 모델에 사전 반영하는 것이 유의미하다.

---

### OKPOS 주문취소·결제취소(반품) 흐름

- 조사일: 2026-09-11
- URL: https://okpos.gitbook.io/okpos/table_qr_pay/delivery/undefined-1/phone_visit/cid_cancel_refund , https://okpos.gitbook.io/okpos/undefined-5/undefined/receipts/refund (검색 스니펫 기반, WebFetch 직접 접근 실패)
- 종류: 공식문서 (도움말, 검색 스니펫)
- 신뢰도: 중 (여러 스니펫에서 일관된 절차 확인)

#### 핵심 내용
매장 내 주문 취소는 "선택 취소"(일부 메뉴)와 "전체 취소" 두 가지로 구분된다. 결제 완료 건 취소는 "반품"이라 부르며 결제 전 주문취소와 명확히 분리된 개념이다. 반품 처리 시 영수증에 "반품원거래"로 표시되고 그 위에 새 거래(반품 처리 건)가 생성되는 구조 — 원거래를 삭제하지 않는다.

#### BoardBite POS에 적용할 내용
- "주문 취소(결제 전)"와 "결제 취소/반품(결제 후)"을 서로 다른 상태 전이로 명확히 구분 — "미결제 항목 취소"와 "이미 정산된 항목의 취소(환불/정정)"를 별개 이벤트/로그로 남긴다.
- 취소/반품 시 원거래를 삭제하지 않고 원거래 ↔ 취소 처리 건을 연결된 두 레코드로 남겨 감사 추적이 가능하게 한다.
- 품목 단위 선택 취소와 전체 취소를 모두 지원한다.

#### 적용하지 않을 내용
카드 VAN사 승인취소 연동 절차(실제 PG API 호출)는 적용하지 않는다.

#### 이유
BoardBite는 실제 카드 매입/PG 연동이 없으므로 승인취소 API는 무관하지만, "취소 전/후 구분 + 원거래 보존 + 취소 이벤트 추가 기록" 원칙은 정산 투명성 확보에 중요하므로 채택한다.

---

### 업계 비교 자료: 테이블오더·QR오더·NFC오더 차이 (토더 공식 블로그)

- 조사일: 2026-09-11
- URL: https://www.torder.com/ceoGuide/post/knowhow-tableorder-difference
- 종류: 기술문서/사례 (경쟁사 업체 작성 비교글, OKPOS 자료 아님)
- 신뢰도: 중 (본문 전체 확인됨, 자사 홍보 목적의 비교글이라 편향 가능성 있음)

#### 핵심 내용
"QR오더"는 스마트폰 카메라로 QR을 촬영해 접속, "NFC오더"는 스마트폰을 태그에 접촉하는 방식이다. NFC는 QR 대비 보안성이 높다 — QR은 이미지라 복사/외부 유출 시 매장 밖에서도 주문 가능("큐싱" 위험)하지만, NFC는 근접 태그라 복사·원격 이용이 불가능하다(단, 도입 비용은 NFC가 더 높음). 결제 흐름은 (1) 주문 후 나갈 때 결제(후불), (2) 주문과 동시 결제(선불/즉시) 두 가지로 구분되며, 선결제형은 인력 절감 효과가 있다.

#### BoardBite POS에 적용할 내용
- QR은 외부 유출/장난 주문 위험, NFC는 위변조가 어렵다는 원칙을 참고해 QR 링크에도 테이블별 고유 토큰 + 유효시간(테이블 OPEN 상태일 때만 유효)을 부여하는 보안 설계를 채택한다.
- "후불(나갈 때 결제) vs 선불(즉시 결제)" 구분을 참고해 BoardBite는 후불형(테이블 단위 정산)을 기본 모델로 확정한다.

#### 적용하지 않을 내용
경쟁사의 우위 주장(NFC가 항상 더 낫다는 결론)은 그대로 받아들이지 않고 "보안 특성의 차이"라는 사실관계만 참고한다.

#### 이유
NFC/QR 두 방식을 병행 지원하는 BoardBite 요구사항을 검증하는 데 필요한 보안·운영 트레이드오프를 이해하기 위해 참고했다.

#### 종합 제안 (Agent A)

BoardBite POS의 정산 화면은 "총금액(주문 누적 합계) - 이미 결제된 금액 = 남은 미수금"을 항상 상단에 고정 노출하고, 현금/카드/복합/부분/더치페이/상품별결제를 모두 동일한 "결제 트랜잭션" 엔티티로 다루되 결제수단·대상 품목·대상 인원을 각각 태깅하는 유연한 데이터 모델을 채택한다. 테이블 상태는 "미배정 → OPEN(주문 가능) → 부분정산 중 → 정산완료/CLOSE" 전이를 명시적으로 모델링하고, 주문 취소(결제 전)와 정산 취소/정정(결제 후)을 서로 다른 이벤트로 분리해 원거래를 지우지 않고 감사 추적이 가능하게 한다. QR/NFC 모바일 주문 링크는 테이블별 고유 토큰 + 테이블 OPEN 상태에서만 유효하도록 제한해 외부 유출·장난 주문 리스크를 차단한다. 결제 후 추가 주문이 들어와 "정산완료 항목"과 "미정산 신규 주문"이 공존할 수 있으므로, 정산 이력은 테이블 단위가 아니라 "결제 시도" 단위로 누적 기록한다. OKPOS는 실제 PG/VAN 카드망 연동, 수수료, 배달앱 연동 등 상용 인프라를 갖춘 시스템이므로 BoardBite는 이런 결제망 연동 요소는 배제하고 "기록/정산 투명성" 원칙만 선별적으로 차용한다.

---

# Agent E — 분할결제/정산 데이터 모델 조사

### GitHub Community Discussion #167058 — "Seeking Feedback: POS Database Design"

- 조사일: 2026-09-11
- URL: https://github.com/orgs/community/discussions/167058
- 종류: 아티클(커뮤니티 토론)
- 신뢰도: 중간

#### 핵심 내용
초기 설계에서 Invoice(주문)에 `amount_tendered` 같은 단일 결제 금액 컬럼을 두는 방식이 지적받았다. 리뷰어는 "하나의 인보이스에 여러 번의 부분결제나 서로 다른 결제수단이 들어올 수 있다"는 점을 근거로, 별도의 `Payments` 테이블(Order 1:N Payment)로 바꿔야 한다고 제안한다. "결제 여부/잔액은 저장하지 말고 항상 Payment 테이블을 집계해서 파생시켜라"는 원칙도 제시된다.

#### BoardBite POS에 적용할 내용
Order 테이블에 `paid_amount`, `is_paid` 같은 상태 컬럼을 직접 두지 않고 Payment 테이블을 SUM해서 항상 파생 계산한다. Payment는 Order에 대해 1:N 관계이며 결제수단이 달라도 각각 별도 Payment row로 기록한다.

#### 적용하지 않을 내용
품목별 분할결제까지는 다루지 않는 자료이므로 Order-Payment 1:N까지만 참고하고 품목 단위 배분은 다른 자료로 보완한다.

#### 이유
BoardBite는 결제수단이 자주 섞이므로 Order에 금액을 몰아넣는 단일 컬럼 방식은 처음부터 배제해야 한다.

---

### Modern Treasury Journal — "How to Scale a Ledger, Part V: Immutability and Double-Entry"

- 조사일: 2026-09-11
- URL: https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-v
- 종류: 아티클(핀테크 인프라 기업 엔지니어링 블로그)
- 신뢰도: 높음

#### 핵심 내용
원장은 append-only여야 하며 절대 UPDATE/DELETE로 값을 고치지 않는다. 잔액은 컬럼에 저장하지 않고 원장 엔트리를 합산해서 도출한다. 오류 정정·취소는 "반대 부호의 취소(reversal) 엔트리를 새로 추가"하는 방식으로 처리해 실수와 정정 이력이 모두 남는다.

#### BoardBite POS에 적용할 내용
Payment 레코드는 절대 수정하지 않는다. 결제 취소는 원본 Payment를 가리키는 새로운 VOID/REFUND 타입 Payment 레코드를 추가하는 방식으로 표현한다. 주문/항목의 "결제된 금액"은 컬럼에 저장하지 않고 Payment(+PaymentAllocation) 테이블을 SUM하여 항상 다시 계산한다.

#### 적용하지 않을 내용
완전한 복식부기(계정과목/저널 엔트리) 구조까지는 도입하지 않는다.

#### 이유
학교 축제 운영은 담당 학생이 자주 바뀌고 정산 분쟁이 생기기 쉬우므로 append-only 이력이 분쟁 해결에 유리하다. 완전한 복식부기는 구현 비용 대비 이득이 적다.

---

### Modern Treasury — Pessimistic vs Optimistic Locking / Ledgers API Concurrency Control

- 조사일: 2026-09-11
- URL: https://www.moderntreasury.com/learn/pessimistic-locking-vs-optimistic-locking , https://www.moderntreasury.com/journal/designing-ledgers-with-optimistic-locking
- 종류: 아티클(공식 엔지니어링 블로그)
- 신뢰도: 높음

#### 핵심 내용
이중결제/초과결제 방지에는 두 전략이 있다: (1) `SELECT ... FOR UPDATE`로 행을 잠그는 비관적 락, (2) 버전 컬럼 기반 낙관적 락. 충돌이 잦은 금융 크리티컬 오퍼레이션에는 비관적 락이, 읽기 위주/충돌 드문 상황에는 낙관적 락이 유리하다.

#### BoardBite POS에 적용할 내용
결제 등록은 DB 트랜잭션 안에서 대상 Order/OrderItem 행을 `SELECT ... FOR UPDATE`로 잠그고, `UPDATE ... WHERE remaining_qty >= :qty` 조건부 업데이트로 초과결제를 막는다. 부스 특성상 두 단말이 동시에 결제를 시도할 수 있으므로 비관적 락을 기본으로 채택한다. Payment 삽입 시 `idempotency_key`(unique)로 중복 결제도 방지한다.

#### 적용하지 않을 내용
전체 시스템을 낙관적 락 전용으로 설계하지 않는다.

#### 이유
결제는 크리티컬 오퍼레이션이므로 짧게 잠갔다 푸는 비관적 락 + 조건부 UPDATE 조합이 더 안전하다.

---

### LinkedIn "Designing Splitwise" + DaniWeb "Partial Payment Schema"

- 조사일: 2026-09-11
- URL: https://www.linkedin.com/pulse/designing-splitwise-data-modelling-expense-sharing-shrey-batra , https://www.daniweb.com/programming/databases/threads/154447/partial-payment-schema
- 종류: 아티클 / 커뮤니티 Q&A
- 신뢰도: 중간

#### 핵심 내용
더치페이 앱은 Bill(청구) 헤더 + BillSplits(분담 명세) 자식 테이블로 표현하며, 균등/비율/직접금액 세 가지 분담 모드를 지원해야 한다 — "얼마를 냈는가"와 "얼마를 부담해야 하는가"는 별개 개념. 인보이스에 대한 여러 부분결제는 Payments 자식 테이블로 잡는다.

#### BoardBite POS에 적용할 내용
"정산 방식(균등분할/직접금액분할)"과 "실제 결제 레코드(Payment)"를 분리한다. N명 더치페이는 UI에서 분담액을 계산해 보여주되, DB에는 계산 로직이 아니라 각자 결제한 Payment 레코드만 저장한다. 직접분할은 Payment.amount에 입력값을 그대로 기록한다.

#### 적용하지 않을 내용
Splitwise 특유의 "누가 누구에게 빚졌다(net balance)" Balances/Settlement 구조는 도입하지 않는다.

#### 이유
BoardBite는 사후정산(친구 간 빚 추적)이 필요 없다 — 카운터에서 그 자리에서 바로 결제하고 끝나는 구조이기 때문이다.

---

### 오픈소스 레스토랑 POS 프로젝트 (Floreant POS, ERPNext 기반 POSNext / POS Prime)

- 조사일: 2026-09-11
- URL: https://floreant.org/ , https://github.com/BrainWise-DEV/POSNext , https://github.com/ravindu2012/pos-prime
- 종류: 오픈소스
- 신뢰도: 높음

#### 핵심 내용
Floreant POS(25개국 3만개 매장 사용)는 Ticket에 대해 다중/부분 결제를 지원하고 Split Check, Merge/Void 기능을 제공한다. ERPNext 계열(POSNext, POS Prime)은 `Sales Invoice`(헤더) + `Sales Invoice Item`(품목) + `Sales Invoice Payment`(결제수단별 다중 행)로 다중/부분결제를 구현하며 `allow_partial_payment` 플래그로 정책을 제어한다.

#### BoardBite POS에 적용할 내용
Order-OrderItem-Payment를 헤더/자식/자식 테이블로 분리하는 3단 구조를 채택한다. "부분결제 허용" 플래그 아이디어는 참고하되, BoardBite는 항상 부분결제를 허용하는 도메인이므로 플래그 자체는 불필요하다.

#### 적용하지 않을 내용
ERPNext의 회계 전표(GL Entry, Chart of Accounts) 연동 구조는 가져오지 않는다.

#### 이유
학교 부스 단기 운영은 정식 회계 시스템 연동이 필요 없고 Order/OrderItem/Payment 3단 구조로 충분하다. 다만 다수 매장에서 검증된 구조라는 점에서 설계 방향의 타당성을 뒷받침한다.

---

### Largest Remainder Method / "How to Split a Bill Fairly"

- 조사일: 2026-09-11
- URL: https://en.wikipedia.org/wiki/Largest_remainder_method , https://pandataps.com/tip-calculator/guides/how-to-split-a-bill
- 종류: 아티클 / 이론(선거 의석 배분 이론에서 유래)
- 신뢰도: 높음

#### 핵심 내용
정수 금액을 N명에게 나눌 때, 정수 나눗셈 몫(floor)을 모두에게 배분하고 나머지(인원수보다 작음)만큼 1원씩 특정 인원에게 추가 배분하면 합계가 항상 원래 총액과 정확히 일치한다(Largest Remainder / Hamilton method).

#### BoardBite POS에 적용할 내용
30,000원을 7명이 나눌 때 `base = floor(30000/7) = 4285원`, `remainder = 5원`. 7명 중 5명은 4286원, 2명은 4285원을 부담해 합계를 정확히 30,000원으로 맞춘다. 나머지를 받을 순서는 "먼저 결제하는 순서" 등 결정론적 규칙으로 정한다.

#### 적용하지 않을 내용
소수점/센트 단위 배분은 KRW에 해당 없음(원 단위가 최소단위).

#### 이유
KRW는 소수점이 없으므로 원 단위 나머지 처리 알고리즘이 필요하며, 이 방법은 이미 검증된 표준 해법으로 구현이 매우 단순하다.

---

### Modern Treasury — "Floats Don't Work For Storing Cents"

- 조사일: 2026-09-11
- URL: https://www.moderntreasury.com/journal/floats-dont-work-for-storing-cents
- 종류: 아티클(공식 엔지니어링 블로그)
- 신뢰도: 높음

#### 핵심 내용
부동소수점은 10진 소수를 정확히 표현하지 못해 오차가 누적된다. 실무 표준은 통화의 최소단위를 정수로 저장하는 것이며, 최소단위보다 작은 값이 들어오면 반올림하지 말고 거부해야 한다.

#### BoardBite POS에 적용할 내용
모든 금액 컬럼(단가, 결제 금액, 배분 금액)은 KRW 정수(BIGINT/INTEGER)로 저장한다. KRW는 최소단위가 1원이므로 별도 변환 없이 정수 자체가 최소단위다. 나눗셈이 필요한 곳(더치페이)은 반드시 정수 나눗셈 + 나머지 처리 알고리즘을 쓴다.

#### 적용하지 않을 내용
다국가/다통화 지원은 도입하지 않는다.

#### 이유
BoardBite는 KRW 단일 통화만 다루지만, "정수만 쓴다"는 원칙은 반드시 지켜야 한다 — 부동소수점 오차로 정산이 몇 원씩 안 맞으면 신뢰도가 크게 떨어진다.

#### 종합 제안 (Agent E) — BoardBite POS 결제 데이터 모델(초안)

**1) 엔티티 목록과 주요 필드**

```
Order (하나의 테이블 방문 세션)
- id, table_id(FK), status(OPEN/CLOSED/CANCELED)
- total_amount INT(KRW, OrderItem 합산 파생/캐시)
- created_at, closed_at, version INT(낙관적 락 보조)

OrderItem (주문 항목)
- id, order_id(FK), product_id(FK), product_name_snap
- unit_price INT(KRW), quantity INT, created_at

Payment (결제 레코드, append-only)
- id, order_id(FK)
- kind ENUM('CHARGE','VOID','REFUND')
- method ENUM('CASH','CARD','TRANSFER', ...)
- amount INT(KRW, 항상 양수, kind로 의미 구분)
- payer_label VARCHAR NULL(정산 UI 표시용)
- reversed_payment_id FK -> Payment NULL(VOID/REFUND가 원본 CHARGE 참조)
- idempotency_key VARCHAR UNIQUE
- created_by(FK -> StaffUser), created_at

PaymentAllocation (결제 -> 주문항목 배분, 품목별 분할결제의 핵심)
- id, payment_id(FK), order_item_id(FK)
- quantity INT(이 결제가 커버하는 수량)
- amount INT(이 배분에 해당하는 금액, KRW)
```

관계: Order 1:N OrderItem, Order 1:N Payment, Payment 1:N PaymentAllocation, OrderItem 1:N PaymentAllocation, Payment 0..1:N Payment(자기참조, reversed_payment_id).

핵심 설계 결정: Order/OrderItem에 `paid_amount`/`is_paid` 같은 "현재 상태" 컬럼을 직접 두지 않고 Payment/PaymentAllocation을 SUM해서 파생시킨다(캐시 컬럼을 두더라도 Payment가 단일 진실 공급원). 결제 취소는 Payment row를 UPDATE/DELETE하지 않고 `kind='VOID'`인 새 Payment(+PaymentAllocation)를 추가해 원본을 상쇄한다. VOID는 "즉시 취소", REFUND는 "이미 마감/정산된 결제의 사후 환불"로 구분한다.

**2) N명 더치페이 나머지 원 처리 알고리즘 (의사코드)**

```
function splitEvenly(totalAmount: int, n: int) -> int[n]:
    base = floor(totalAmount / n)
    remainder = totalAmount - base * n   # 0 <= remainder < n
    shares = array of size n, all filled with base
    for i in 0 until remainder:
        shares[i] += 1
    assert sum(shares) == totalAmount
    return shares

# 예: 30,000원 / 7명 -> base=4285, remainder=5
# shares = [4286,4286,4286,4286,4286,4285,4285] (합계 정확히 30000)
```

각자의 몫(shares[i])은 그대로 개별 Payment.amount로 기록한다(분할 계산식 자체를 저장할 필요 없음). 직접분할은 이 알고리즘을 거치지 않고 사용자가 입력한 값을 그대로 기록하되, 모든 Payment.amount 합이 대상 금액을 초과하지 않는지 서버에서 반드시 검증한다.

**3) 상품별 분할결제 시 "이미 결제된 수량" 검증**

```sql
SELECT oi.id, oi.quantity AS ordered_qty,
  COALESCE(SUM(CASE WHEN p.kind='CHARGE' THEN pa.quantity
                     WHEN p.kind IN ('VOID','REFUND') THEN -pa.quantity
                     ELSE 0 END), 0) AS paid_qty
FROM order_item oi
LEFT JOIN payment_allocation pa ON pa.order_item_id = oi.id
LEFT JOIN payment p ON p.id = pa.payment_id
WHERE oi.id = :order_item_id
GROUP BY oi.id, oi.quantity;
```

트랜잭션 내에서 대상 OrderItem 행을 `SELECT ... FOR UPDATE`로 잠근 뒤 `remaining_qty = quantity - paid_qty`를 재계산하고, `remaining_qty < requested_qty`이면 롤백한다. 동일 상품 2개 중 1개만 결제하는 경우 첫 결제가 `PaymentAllocation.quantity=1`을 기록하면 남은 1개(`remaining_qty=1`)를 다른 손님이 결제할 수 있다.

**4) 동시성 제어 전략**

부스 특성상 여러 단말이 동시에 같은 테이블을 결제할 가능성이 낮지 않으므로 비관적 락 + 조건부 UPDATE를 기본 전략으로 채택한다. `READ COMMITTED` 이상 격리수준에서 결제 처리 구간은 `SELECT ... FOR UPDATE`로 직렬화하고, 최종 INSERT 직전 `UPDATE ... WHERE (quantity - paid_qty) >= :qty` 조건부 갱신으로 이중 안전장치를 둔다. 낙관적 락(버전 컬럼)은 보조 수단으로만 사용한다. `Payment.idempotency_key` UNIQUE 제약으로 중복 결제 요청을 원천 차단하며, 락은 Order 전체가 아니라 실제 갱신 대상 OrderItem 행 단위로 최소화해 같은 테이블의 다른 상품 결제는 병렬 처리 가능하게 한다.

---

# Agent C — 모바일 UX/UI 및 Toss 디자인 원칙 조사

### 토스 UX 라이팅 가이드 (Consumer UX Guide)

- 조사일: 2026-09-11
- URL: https://developers-apps-in-toss.toss.im/design/consumer-ux-guide.html
- 종류: 공식문서 / 디자인시스템
- 신뢰도: 높음

#### 핵심 내용
마이크로카피 5원칙: 해요체 통일, 능동태 우선, 긍정형 표현 우선, 과도한 존댓말 지양, 한자어 명사 조합 대신 동사형 문장. 다이얼로그 종료 버튼은 "닫기"로 통일하고 진행 중 작업이 없는데 "취소"를 쓰면 오해를 유발한다. CTA는 "다음에 무엇이 일어나는지"를 알려주는 장치여야 하며 화면당 핵심 그래픽은 하나만 쓴다. 오해를 유발하는 그래픽(불필요한 로딩 애니메이션, 오류 아닌데 느낌표 아이콘) 사용을 금지하고, 특정 CTA 외 선택지가 없는 강제 구조는 다크패턴으로 명시적으로 금지한다.

#### BoardBite POS에 적용할 내용
"해요체+능동태+긍정형" 3원칙을 마이크로카피 톤 기준으로 채택. 실제 대기시간이 있는 액션(주문 전송, 결제 확인)에만 로딩 표시. CTA는 "주문하기"/"결제 확인하기"처럼 다음 행동을 예고하는 동사형으로 작성. 뒤로가기 없는 강제 결제 확인 화면을 만들지 않는다.

#### 적용하지 않을 내용
토스 특유의 캐릭터/카피 말투는 차용하지 않는다.

#### 이유
"해요체+긍정형+명확한 CTA"는 범용 언어 원칙이지만, 특정 브랜드의 말투·유머 코드를 복제하면 표절 소지와 톤 불일치가 생긴다.

---

### 토스 디자인 시스템(TDS) 컴포넌트 개요

- 조사일: 2026-09-11
- URL: https://developers-apps-in-toss.toss.im/design/components.html
- 종류: 공식문서 / 디자인시스템
- 신뢰도: 중간 (목차만 확인, 상세 페이지 일부 접근 실패)

#### 핵심 내용
TDS 핵심 컴포넌트: Badge, Border, BottomCTA, Button, Asset, ListRow, ListHeader, Navigation, Paragraph, Tab, Top. 화면 하단 고정 액션은 BottomCTA라는 전용 컴포넌트로 "리스트 아이템"과 구조적으로 분리되어 있다.

#### BoardBite POS에 적용할 내용
화면 하단에 항상 떠 있는 결제/주문 액션 영역을 별도 고정 컴포넌트(BottomCTA 패턴)로 분리하고, 스크롤 영역(메뉴 리스트)과 고정 액션 영역을 명확히 나눈다. 메뉴/옵션은 카드형보다 ListRow류의 리스트 행 패턴을 기본으로 채택한다.

#### 적용하지 않을 내용
컴포넌트 이름·API 구조·아이콘 세트를 그대로 이식하지 않는다.

#### 이유
목적(스크롤 콘텐츠 vs 고정 액션)에 따라 구조를 분리하는 사고방식은 브랜드에 종속되지 않는 범용 UI 아키텍처 원칙이다.

---

### Toss Design System Mobile — Typography / Colors Foundation

- 조사일: 2026-09-11
- URL: https://tossmini-docs.toss.im/tds-mobile/foundation/typography/ , https://tossmini-docs.toss.im/tds-mobile/foundation/colors/
- 종류: 공식문서 / 디자인시스템
- 신뢰도: 높음

#### 핵심 내용
타이포그래피는 7~10단계 크기 토큰 × 5단계 굵기(Light~Bold) 조합으로 위계를 세분화하며 값은 하드코딩하지 않고 토큰으로 참조한다. 색상 배경 토큰 4종 중 3종이 흰색으로 고정되고 회색 배경만 별도 톤을 쓰며, 유채색은 Grey+7개 색상군이 각 9단계 명도 스케일을 갖는다. 최근 컬러 시스템은 OKLCH 등 지각적으로 균일한 색공간으로 배경-텍스트 대비를 자동 보장하는 방향으로 발전 — "색은 화려함이 아니라 대비/가독성 보장 도구".

#### BoardBite POS에 적용할 내용
화면당 폰트 크기 5~6단계로 제한하는 타이포 스케일 채택. 금액/주문번호는 최상위 크기+Bold, 상태 설명은 중간 크기+Regular, 안내 문구는 최소 크기로 분리. 배경은 흰색 기본, 구분 필요 시에만 옅은 회색 1단계 추가. 포인트 컬러는 1~2개로 제한하고 명도 스케일로 강조/보조를 구분.

#### 적용하지 않을 내용
Toss의 정확한 px 수치·토큰 이름, blue500 같은 브랜드 색상 값은 그대로 쓰지 않는다.

#### 이유
"계층적 타이포 스케일+하드코딩 금지"와 "화이트 베이스+명도 스케일 포인트 컬러"는 업계 공통 원칙이지만, 실제 수치/색상값을 그대로 쓰면 브랜드 종속·표절 위험이 있어 BoardBite 고유 값으로 새로 정의한다.

---

### KRDS(한국지능정보사회진흥원) 바텀시트 컴포넌트 가이드

- 조사일: 2026-09-11
- URL: https://www.krds.go.kr/html/site/component/component_12_03.html
- 종류: 공식문서(정부 디자인시스템)
- 신뢰도: 높음 (공공 표준, 브랜드 종속 없음)

#### 핵심 내용
바텀시트 구조 5요소: 오버레이/헤더(선택)/핸들/본문/닫기 버튼. 화면 전환 없이 부가 정보를 보여줄 때 적합하고, 상시 노출 정보나 긴 콘텐츠(정책 확인 등)에는 부적합하다. 스와이프/탭으로 닫는 제스처만으로는 부족하며 반드시 명시적 닫기(X) 버튼이 필요하고, 바텀시트 중첩은 지양한다.

#### BoardBite POS에 적용할 내용
메뉴 옵션 선택(수량, 세트 구성)이나 주문 확인 요약처럼 짧고 맥락 유지가 중요한 액션에 바텀시트를 사용한다. 항상 명시적 닫기 버튼을 배치하고, 2단 이상 중첩하지 않는다.

#### 적용하지 않을 내용
없음.

#### 이유
정부 표준 디자인 시스템은 브랜드 자산이 아니므로 원칙과 패턴을 폭넓게 참고해도 문제가 없다.

---

### iOS Safari Safe Area & 터치 영역 실무 가이드

- 조사일: 2026-09-11
- URL: 종합 (Apple 공식 포럼, CSS-Tricks `env()` 문서, Apple HIG 터치 타겟 기준 등)
- 종류: 공식문서 + 실무 아티클 혼합
- 신뢰도: 중간~높음

#### 핵심 내용
`viewport-fit=cover` + `env(safe-area-inset-*)`로 상/하단 여백을 확보해야 하며, 실무에서는 `padding-bottom: calc(env(safe-area-inset-bottom) + 44px)`처럼 여유를 더해 하단 고정 버튼이 실제로 눌리도록 보정한다. iOS 15+에서 툴바 숨김 시 `safe-area-inset-bottom`이 0으로 반환되는 알려진 버그가 있어 고정값 폴백이 필요하다. Apple HIG 공식 기준: 모든 인터랙션 컨트롤의 최소 탭 영역은 44×44pt.

#### BoardBite POS에 적용할 내용
전체 페이지에 `viewport-fit=cover` + `env(safe-area-inset-top/bottom)` 적용. 하단 고정 버튼은 `padding-bottom: max(16px, env(safe-area-inset-bottom))` + 최소 고정 여백 이중 안전장치. 모든 탭 요소는 시각 크기와 무관하게 최소 44×44px 히트 영역(권장 48px+) 확보.

#### 적용하지 않을 내용
특정 프레임워크 종속적 브라우저 분기 유틸은 그대로 가져오지 않고 프로젝트 스택에 맞게 재작성한다.

#### 이유
플랫폼 기술 제약에 대한 대응이므로 원칙과 구현 패턴을 그대로 채택해도 무방하다.

---

### 숫자·금액 강조 타이포그래피 & 국내 커머스 가격 표기 패턴

- 조사일: 2026-09-11
- URL: 종합 (tabular-nums 관련 아티클, KRDS 스타일 가이드, 국내 커머스 사례 분석)
- 종류: 아티클 + 사례 분석
- 신뢰도: 중간

#### 핵심 내용
`font-variant-numeric: tabular-nums`를 적용하면 숫자가 고정폭으로 정렬되어 가격/합계/수량이 세로 나열될 때 자릿수가 흔들리지 않는다. 국내 커머스는 단일 강조색+굵은 글씨로 가격을 시각 위계상 최상위에 배치하는 경향이 있다. 공공 가이드(KRDS)도 "글꼴/크기/두께/간격으로 중요도에 따라 구분"을 타이포그래피 위계의 기본 원칙으로 제시한다.

#### BoardBite POS에 적용할 내용
메뉴 가격/주문 합계/테이블 번호에 `tabular-nums` 적용. 합계 금액은 최대 크기+Bold+포인트 컬러로 강조하고 낱개 메뉴 가격은 한 단계 작게 차등화.

#### 적용하지 않을 내용
특정 커머스 브랜드의 색상·정보 밀집형 레이아웃은 차용하지 않는다(BoardBite는 여백형 지향).

#### 이유
숫자 정렬/강조는 기술 원칙이라 자유롭게 채택 가능하지만 특정 브랜드 색상/레이아웃을 베끼면 표절 및 톤 불일치 우려가 있다.

---

### 바텀시트 유형(modal/non-modal) 및 폼 단순화 실무 원칙

- 조사일: 2026-09-11
- URL: 종합 (국내 UX 실무 아티클, KRDS 컴포넌트 가이드)
- 종류: 실무 아티클 + 디자인시스템
- 신뢰도: 중간

#### 핵심 내용
바텀시트는 modal(배경 차단, 중요한 결정용)과 non-modal(배경 상호작용 가능, 가벼운 선택용)로 나뉜다. 선택지가 적을 때는 카드/그리드보다 세로 리스트가 스캔 속도가 빠르고 오터치가 적다. 불필요한 선택 단계를 제거해 입력 단계 수를 줄이는 것이 전환율에 유리하다.

#### BoardBite POS에 적용할 내용
가벼운 옵션 선택(매운맛, 인원수)은 non-modal 리스트/바텀시트로, 주문 확정처럼 되돌리기 부담이 큰 액션은 modal 바텀시트+명시적 확인 버튼으로 구분한다. 부스 운영에 불필요한 입력 필드(전화번호 등)는 제거한다.

#### 적용하지 않을 내용
특정 커머스 서비스의 구체적 화면 레이아웃/문구는 재현하지 않는다.

#### 이유
UX 리서치 커뮤니티에서 널리 합의된 상호작용 패턴이라 원칙 차용에 문제가 없으며, 학생 대상의 단순한 결제 흐름에는 입력 단계 최소화가 특히 중요하다.

---

### 사용자 제공 레퍼런스(Medium, bunny753358) — 접근 제한

- 조사일: 2026-09-11
- URL: https://medium.com/@bunny753358/자주-사용하는-ux-ui-레퍼런스-사이트-91381826ca00
- 종류: 아티클 (접근 실패, HTTP 403)
- 신뢰도: 낮음 — 원문 미확인, 아래는 검색으로 확인된 간접 정보

#### 핵심 내용
원문 접근이 차단되어 직접 인용할 수 없었다. 대신 검색으로 확인된, 국내 UX 실무자들이 공통적으로 언급하는 레퍼런스 유형: Mobbin, WWIT, Awwwards, Dribbble 등 화면 아카이브형 사이트.

#### BoardBite POS에 적용할 내용
아카이브형 사이트는 "국내 모바일 커머스/주문 앱의 정보 위계, CTA 배치, 바텀시트 처리 방식"을 폭넓게 비교하는 용도로만 참고하고 특정 화면을 재현하지 않는다.

#### 적용하지 않을 내용
원문 미확인 상태이므로 이 글의 특정 주장을 근거로 단정적인 디자인 결정을 내리지 않는다.

#### 이유
접근 실패한 자료를 확인한 것처럼 인용하면 리서치 신뢰도가 훼손된다. 접근 제한 사실을 명시하고 검증 가능한 보완 정보로 대체했다.

#### 종합 제안 (Agent C) — BoardBite POS 고객 화면 디자인 원칙

**색상**: 배경 `#FFFFFF` 고정(구분 필요 시 `#F5F6F8` 1단계만 추가). 텍스트 `#191F28`(본문)/`#6B7684`(보조)/`#B0B8C1`(비활성). 포인트 컬러 1개(예: 차분한 그린 계열, `#00A876`)를 CTA·합계 금액·선택 상태에만 사용. 상태색은 성공=포인트 그린, 경고/품절=앰버(`#F5A623`), 오류=레드(`#E5484D`)로 한정. 한 화면에 유채색 최대 2개.

**타이포그래피(px/line-height/굵기)**: Display 28/36 Bold(합계 금액) · Title 22/30 Semibold(화면 제목) · Subtitle 18/26 Semibold(메뉴명) · Body 16/24 Regular(설명) · Caption 14/20 Regular(보조 설명) · Micro 12/16 Regular(안내문). 금액/숫자는 `tabular-nums` 전역 적용, `rem` 단위 사용, 한 화면 최대 3~4단계만 동시 사용.

**여백/레이아웃**: 스페이싱 스케일 4/8/12/16/24/32/48px, 화면 좌우 여백 16px, 섹션 간격 24~32px. Radius: 버튼/입력 12px, 카드/바텀시트 상단 20px, 뱃지 999px(pill). 하단 고정 영역 `padding-bottom: max(16px, env(safe-area-inset-bottom))`.

**컴포넌트 원칙**: 주요 CTA는 화면당 1개, 하단 고정, 최소 높이 52px. 메뉴/옵션은 세로 리스트 우선(카드는 요약 정보에만 제한적 사용). 바텀시트는 가벼운 선택=non-modal, 중요한 확정=modal+명시적 확인, 항상 닫기 버튼, 2단 이상 중첩 금지. 모든 탭 요소 최소 44×44px 히트 영역.

**상태 피드백**: 실제 대기시간 있는 액션에만 로딩 표시. 성공은 그린+짧은 확인 문구+다음 행동 안내. 실패는 레드+원인/해결방법+재시도 CTA. 품절은 회색 비활성 처리+"품절" 뱃지(경고색 남용 금지).

**카피 톤**: 해요체, 능동태, 긍정형. 문장은 15자 내외로 짧게. CTA는 "동사+목적어"(예: "담기", "결제하기"). "취소"는 실제 취소 동작에만, 단순히 닫을 때는 "닫기". 오류/품절 문구는 원인+다음 행동을 함께 제시.
