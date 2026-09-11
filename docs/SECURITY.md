# SECURITY.md

> Phase 0/1 산출물. 위협 모델과 대응을 기록한다. 구현 단계마다 갱신한다.

## 1. 위협 모델 (STRIDE 관점, 작성 예정)

- IDOR/BOLA (다른 테이블 접근)
- 순차 테이블 번호 조작
- 공개 QR URL 공유/재사용
- CLOSED 테이블 주문
- 이전 손님 세션 재사용
- 클라이언트 가격/수량 조작
- 주문 더블탭/재전송(replay)
- 로그인 brute force
- 세션 탈취/고정
- CSRF / XSS / SQL Injection
- Role escalation, 관리자 API 직접 호출
- 결제 중복, 동시 부분결제 race condition
- Audit log tampering
- Public GitHub secret leak

## 2. 대응 매핑

(작성 예정 — 각 위협 → 구체적 대응/구현 위치)

## 3. 인증/세션 설계

(작성 예정)

## 4. 데이터 보호

(작성 예정)

## 5. 보안 테스트 체크리스트

`docs/TEST-PLAN.md`와 연동. (작성 예정)
