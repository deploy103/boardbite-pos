import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../prisma.js";

/**
 * 로그인 brute force 방어 (요구사항2.md §4.1).
 *
 * 이전 정책의 문제: "같은 username 5회 실패 → 5분간 하드 락"은, 공격자가 admin/front/pos/serving
 * 아이디만 알면 틀린 비밀번호를 5번 보내는 것만으로 행사 내내 운영진을 로그인 불가 상태로
 * 만들 수 있는 DoS였다.
 *
 * 새 정책:
 *  - (계정 + IP) 조합에 대해서만 짧은 차단을 건다. 공격자의 IP는 막히지만, 다른 자리에서
 *    접속하는 정상 운영자는 영향을 받지 않는다.
 *  - 실패가 쌓이면 응답에 지수적 지연을 넣어 대량 시도의 채산성을 떨어뜨린다(락 대신 감속).
 *  - IP 단위 차단은 유지하되 임계값을 넉넉히 둔다.
 *  - 계정 전체(모든 IP 합산)에 대해서는 "분산 공격 탐지"용으로 매우 높은 임계값만 둔다.
 *  - 어떤 경우에도 응답은 계정 존재 여부를 드러내지 않는다.
 */

/** (username, ip) 조합 — 이 IP에서 이 계정으로 반복 실패한 경우. */
const PAIR_FAIL_THRESHOLD = 8;
const PAIR_WINDOW_MS = 10 * 60 * 1000;

/** IP 단위 — 한 IP가 여러 계정을 훑는 경우. NAT 공유를 감안해 넉넉히 둔다. */
const IP_FAIL_THRESHOLD = 30;
const IP_WINDOW_MS = 60 * 60 * 1000;

/** 계정 단위(모든 IP 합산) — 분산 공격 탐지용. 단일 공격자가 쉽게 도달하지 못할 만큼 높게. */
const ACCOUNT_FAIL_THRESHOLD = 60;
const ACCOUNT_WINDOW_MS = 30 * 60 * 1000;

/** 지수 backoff — 3회째 실패부터 지연을 넣고 최대 4초까지만 늘린다. */
const BACKOFF_FREE_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4000;

const GENERIC_BLOCK_MESSAGE = "로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.";

export interface LoginGateResult {
  allowed: boolean;
  /** 계정 존재 여부를 드러내지 않는 일반 문구. */
  reason?: string;
}

export function backoffDelayMs(failureCount: number): number {
  if (failureCount <= BACKOFF_FREE_ATTEMPTS) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failureCount - BACKOFF_FREE_ATTEMPTS - 1), BACKOFF_MAX_MS);
}

export async function assertLoginAllowed(username: string, ip: string | undefined): Promise<LoginGateResult> {
  const now = Date.now();

  if (ip) {
    const [pairFailures, ipFailures] = await Promise.all([
      prisma.loginAttempt.count({
        where: { username, ip, succeeded: false, createdAt: { gte: new Date(now - PAIR_WINDOW_MS) } },
      }),
      prisma.loginAttempt.count({
        where: { ip, succeeded: false, createdAt: { gte: new Date(now - IP_WINDOW_MS) } },
      }),
    ]);

    if (pairFailures >= PAIR_FAIL_THRESHOLD || ipFailures >= IP_FAIL_THRESHOLD) {
      return { allowed: false, reason: GENERIC_BLOCK_MESSAGE };
    }

    // 하드 락 대신 감속: 정상 사용자는 체감하지 못하고 자동화 공격만 느려진다.
    const wait = backoffDelayMs(Math.max(pairFailures, 0));
    if (wait > 0) await delay(wait);
    return { allowed: true };
  }

  // IP를 알 수 없는 요청(프록시 설정 오류 등)에는 계정 단위 임계값만 적용한다.
  const accountFailures = await prisma.loginAttempt.count({
    where: { username, succeeded: false, createdAt: { gte: new Date(now - ACCOUNT_WINDOW_MS) } },
  });
  if (accountFailures >= ACCOUNT_FAIL_THRESHOLD) {
    return { allowed: false, reason: GENERIC_BLOCK_MESSAGE };
  }
  const wait = backoffDelayMs(accountFailures);
  if (wait > 0) await delay(wait);
  return { allowed: true };
}

/**
 * 계정 전체에 대한 분산 공격 탐지. IP별 임계값을 우회하려고 여러 IP에서 같은 계정을
 * 두드리는 경우를 잡는다. 임계값이 매우 높으므로 정상 운영을 막는 DoS로 쓰이기 어렵다.
 */
export async function detectDistributedAccountAttack(username: string): Promise<boolean> {
  const failures = await prisma.loginAttempt.count({
    where: { username, succeeded: false, createdAt: { gte: new Date(Date.now() - ACCOUNT_WINDOW_MS) } },
  });
  return failures >= ACCOUNT_FAIL_THRESHOLD;
}

export async function recordLoginAttempt(input: {
  username: string;
  succeeded: boolean;
  ip?: string;
  staffUserId?: string;
}): Promise<void> {
  await prisma.loginAttempt.create({
    data: {
      username: input.username,
      succeeded: input.succeeded,
      ip: input.ip,
      staffUserId: input.staffUserId,
    },
  });
}

/** 로그인 성공 시 그 (계정, IP) 조합의 실패 기록을 지워 backoff를 초기화한다. */
export async function clearFailedAttempts(username: string, ip: string | undefined): Promise<void> {
  await prisma.loginAttempt.deleteMany({
    where: { username, succeeded: false, ...(ip ? { ip } : {}) },
  });
}

export const LOGIN_GUARD_THRESHOLDS = {
  PAIR_FAIL_THRESHOLD,
  IP_FAIL_THRESHOLD,
  ACCOUNT_FAIL_THRESHOLD,
} as const;
