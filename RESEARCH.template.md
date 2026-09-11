# RESEARCH.md

> 구현 전에 먼저 작성한다. 공식 문서/신뢰할 수 있는 자료를 우선한다.
> 조사 결과는 그대로 복제하기 위한 것이 아니라 BoardBite POS의 기능/UX/보안 결정을 위한 근거다.

## 조사 체크리스트

- [ ] OKPOS 후불형/테이블 주문
- [ ] OKPOS 받은금액/거스름돈
- [ ] OKPOS 복합결제/부분결제
- [ ] OKPOS QR오더
- [ ] 배민 주문접수 PC/Lite
- [ ] KDS 주문 상태/타이머/지연 표시
- [ ] 상품별/더치/분할 정산 데이터 모델
- [ ] QR/NFC 테이블 보안
- [ ] OWASP IDOR/BOLA/RBAC/CSRF/XSS
- [ ] Toss Design System
- [ ] 사용자 제공 UX/UI 레퍼런스
- [ ] iOS Safari 모바일 UI
- [ ] 네트워크 재연결/중복 주문
- [ ] Public GitHub secret 관리

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
