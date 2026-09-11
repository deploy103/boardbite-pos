import { prisma } from "../prisma.js";

const ACCOUNT_FAIL_THRESHOLD = 5;
const ACCOUNT_LOCK_WINDOW_MS = 5 * 60 * 1000; // 5분
const IP_FAIL_THRESHOLD = 15;
const IP_LOCK_WINDOW_MS = 60 * 60 * 1000; // 1시간

/**
 * 로그인 brute force 방지: 계정 단위 + IP 단위 rate limit을 함께 적용한다.
 * docs/SECURITY.md §1, docs/RESEARCH.md Agent D 근거.
 */
export async function assertLoginAllowed(username: string, ip: string | undefined): Promise<{ allowed: boolean; reason?: string }> {
  const accountWindowStart = new Date(Date.now() - ACCOUNT_LOCK_WINDOW_MS);
  const accountFailures = await prisma.loginAttempt.count({
    where: { username, succeeded: false, createdAt: { gte: accountWindowStart } },
  });
  if (accountFailures >= ACCOUNT_FAIL_THRESHOLD) {
    return { allowed: false, reason: "로그인 실패 횟수가 많아 잠시 후 다시 시도해 주세요." };
  }

  if (ip) {
    const ipWindowStart = new Date(Date.now() - IP_LOCK_WINDOW_MS);
    const ipFailures = await prisma.loginAttempt.count({
      where: { ip, succeeded: false, createdAt: { gte: ipWindowStart } },
    });
    if (ipFailures >= IP_FAIL_THRESHOLD) {
      return { allowed: false, reason: "요청이 많아 잠시 후 다시 시도해 주세요." };
    }
  }

  return { allowed: true };
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
