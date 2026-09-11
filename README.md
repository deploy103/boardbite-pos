# BoardBite POS

학교 반 부스에서 운영하는 보드게임 카페형 행사를 위한 **테이블오더 + KDS(주방) + POS + 정산** 통합 시스템.

> 이 프로젝트는 현재 조사(Phase 0) 및 설계(Phase 1) 단계입니다. 진행 상황은 [`docs/DEVLOG.md`](docs/DEVLOG.md)와 [`docs/HANDOFF.md`](docs/HANDOFF.md)에서 확인할 수 있습니다.

## 운영 흐름 요약

```text
손님 입장 → FRONT 자리 배정 → 테이블 OPEN → 고객 NFC/QR 주문
→ 주방(KDS) 접수/조리 → SERVING 서빙 완료 → FRONT 정산(부분/복합/더치/상품별)
→ 잔액 0 → 고객 세션 폐기 → 테이블 자동 CLOSE
```

## 문서

| 문서 | 설명 |
|---|---|
| [AGENTS.md](AGENTS.md) | 개발 에이전트 운영 규칙 |
| [요구사항.md](요구사항.md) | 전체 기능 요구사항 |
| [docs/RESEARCH.md](docs/RESEARCH.md) | 벤치마크 조사 (OKPOS/배민/KDS/UX/보안) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 아키텍처, 데이터 모델, 상태 머신 |
| [docs/SECURITY.md](docs/SECURITY.md) | 위협 모델 및 보안 대응 |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | 테스트 계획 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 부스 운영 매뉴얼 |
| [docs/HANDOFF.md](docs/HANDOFF.md) | 다음 작업자를 위한 인수인계 |
| [docs/adr/](docs/adr/) | 아키텍처 결정 기록 (ADR) |

## 로컬 실행 (예정)

기술 스택 선택이 완료되면 이 섹션에 다음 내용을 채웁니다.

- 요구 사항 (Node 버전 등)
- 설치: `npm install`
- 환경변수: `.env.example`을 `.env`로 복사 후 값 채우기
- 개발 서버 실행 명령
- 시드 계정: `.env`의 `ADMINID/ADMINPASSWORD` 등 부트스트랩 계정으로 로그인
- 테스트 실행 명령

## 기본 계정 (부트스트랩)

`.env.example` 참고. 실제 배포 전 반드시 비밀번호를 변경합니다.

## 라이선스

[MIT](LICENSE)
