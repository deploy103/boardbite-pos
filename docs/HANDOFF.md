# HANDOFF.md

> 다른 에이전트/개발자가 이 문서만 읽고 이어받을 수 있도록 최신 상태를 유지한다.

## 현재 단계

Phase 1(설계) 완료, Phase 2(핵심 기반 구현) 착수 대기 (2026-09-11)

## 지금까지 완료된 것

- GitHub 저장소 `boardbite-pos` 생성(https://github.com/deploy103/boardbite-pos) 및 로컬 git 초기화, push 완료
- `.gitignore`, `.env.example`, `LICENSE`, `README.md` 작성
- Phase 0 조사 완료 및 `docs/RESEARCH.md`에 전체 병합(OKPOS/배민·KDS/UX·Toss/보안/결제데이터모델, 5개 종합 제안 포함)
- Phase 1 설계 완료:
  - `docs/adr/0001-tech-stack.md` — Node.js/TS + Express + Prisma + SQLite + React(Vite) + Socket.IO
  - `docs/adr/0002-realtime-communication.md` — Socket.IO + REST 재동기화
  - `docs/adr/0003-auth-session.md` — 직원 서버세션 / 손님 테이블 토큰 분리
  - `docs/adr/0004-table-token.md` — publicSlug + TableSession.token 2단 구조
  - `docs/ARCHITECTURE.md` — Prisma 스키마 초안, 역할/권한표, 상태 머신, API 계약 요약
  - `docs/SECURITY.md` — 위협→대응 매핑
  - `docs/TEST-PLAN.md` — 테스트 전략/시나리오

## 아직 안 된 것

- 실제 프로젝트 스캐폴딩(Node/TS/Express/Prisma/React 초기 세팅) — 코드 0줄 상태
- Phase 2~7 전체 구현 (`AGENTS.md` §5 참고)

## 다음 작업자가 가장 먼저 할 일

1. `docs/DEVLOG.md` 최신 항목과 `docs/ARCHITECTURE.md`를 읽는다.
2. 모노레포 구조로 프로젝트 스캐폴딩 시작 (`server/`, `client/` 또는 유사 구조) — package.json, TypeScript 설정, Prisma 초기화.
3. `docs/ARCHITECTURE.md` §4의 Prisma 스키마 초안을 실제 `schema.prisma`로 옮기고 첫 마이그레이션 생성.
4. `.env.example`의 부트스트랩 계정을 시드하는 스크립트 작성 후 인증/세션(직원 로그인, 역할별 리다이렉트)부터 구현.
5. Phase 2 완료 기준(AGENTS.md §5): 인증, 역할 권한, 메뉴, 테이블, 테이블 OPEN/CLOSE, 고객 테이블 세션, 주문 생성, 감사 로그.

## 알려진 blocker

없음.
