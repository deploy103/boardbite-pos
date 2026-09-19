import { describe, it, expect } from "vitest";
import { prisma } from "../src/prisma.js";
import { recordAuditLog, verifyAuditLogChain, purgeAuditLogs } from "../src/services/auditLog.js";
import { createStaff, loginAgent, elevate } from "./helpers.js";

describe("감사 로그 정리(purge)", () => {
  it("기준 날짜 이전 로그를 삭제하고, 삭제 자체가 새 감사 로그로 남는다", async () => {
    const marker = `purge-test-${Date.now()}`;
    await recordAuditLog({ actorType: "SYSTEM", action: `${marker}-old-1` });
    await recordAuditLog({ actorType: "SYSTEM", action: `${marker}-old-2` });

    const cutoff = new Date(Date.now() + 1000); // 방금 만든 로그 2건을 모두 포함하도록 미래 시각
    const admin = await createStaff("ADMIN");
    const staffId = (await prisma.staffUser.findUniqueOrThrow({ where: { username: admin.username } })).id;

    const before = await prisma.auditLog.count({ where: { action: { in: [`${marker}-old-1`, `${marker}-old-2`] } } });
    expect(before).toBe(2);

    const result = await purgeAuditLogs(cutoff, staffId);
    expect(result.deletedCount).toBeGreaterThanOrEqual(2);

    const after = await prisma.auditLog.count({ where: { action: { in: [`${marker}-old-1`, `${marker}-old-2`] } } });
    expect(after).toBe(0);

    const purgeLog = await prisma.auditLog.findFirst({
      where: { action: "AUDIT_LOG_PURGE", actorId: staffId },
      orderBy: { createdAt: "desc" },
    });
    expect(purgeLog).not.toBeNull();
  });

  it("AUDIT_LOG_PURGE 레코드 자체는 정리 대상에서 제외되어 항상 남는다", async () => {
    const admin = await createStaff("ADMIN");
    const staffId = (await prisma.staffUser.findUniqueOrThrow({ where: { username: admin.username } })).id;

    await purgeAuditLogs(new Date(Date.now() + 1000), staffId);
    const purgeCountBefore = await prisma.auditLog.count({ where: { action: "AUDIT_LOG_PURGE" } });
    expect(purgeCountBefore).toBeGreaterThan(0);

    // 아주 먼 미래를 기준으로 다시 정리해도 AUDIT_LOG_PURGE 레코드들은 삭제되지 않는다.
    await purgeAuditLogs(new Date(Date.now() + 2000), staffId);
    const purgeCountAfter = await prisma.auditLog.count({ where: { action: "AUDIT_LOG_PURGE" } });
    expect(purgeCountAfter).toBeGreaterThanOrEqual(purgeCountBefore + 1);
  });

  it("정리 이후에도 해시체인 검증은 '변조'가 아니라 정상으로 판단한다", async () => {
    const admin = await createStaff("ADMIN");
    const staffId = (await prisma.staffUser.findUniqueOrThrow({ where: { username: admin.username } })).id;

    await recordAuditLog({ actorType: "SYSTEM", action: "before-purge-marker" });
    await purgeAuditLogs(new Date(Date.now() + 1000), staffId);
    await recordAuditLog({ actorType: "SYSTEM", action: "after-purge-marker" });

    const brokenAt = await verifyAuditLogChain();
    expect(brokenAt).toBeNull();
  });

  it("ADMIN API로 정리하면 step-up과 confirm이 모두 있어야 성공한다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);

    // 감사 로그 삭제는 고위험 작업이므로 재인증 없이는 confirm이 있어도 막힌다(요구사항2.md §2.5.2).
    const withoutStepUp = await admin
      .post("/api/staff/admin/audit-logs/purge")
      .set("X-BoardBite-Client", "1")
      .send({ beforeDate: new Date().toISOString(), confirm: true });
    expect(withoutStepUp.status).toBe(403);
    expect(withoutStepUp.body.code).toBe("STEP_UP_REQUIRED");

    await elevate(admin, password);

    const withoutConfirm = await admin
      .post("/api/staff/admin/audit-logs/purge")
      .set("X-BoardBite-Client", "1")
      .send({ beforeDate: new Date().toISOString() });
    expect(withoutConfirm.status).toBe(400);

    const withConfirm = await admin
      .post("/api/staff/admin/audit-logs/purge")
      .set("X-BoardBite-Client", "1")
      .send({ beforeDate: new Date(Date.now() + 1000).toISOString(), confirm: true });
    expect(withConfirm.status).toBe(200);
    expect(typeof withConfirm.body.result.deletedCount).toBe("number");
  });

  it("감사 로그를 기간/행위자로 필터링해 검색할 수 있다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);
    const staffId = (await prisma.staffUser.findUniqueOrThrow({ where: { username } })).id;

    const res = await admin.get(`/api/staff/admin/audit-logs?actorId=${staffId}&limit=5`);
    expect(res.status).toBe(200);
    expect(res.body.logs.every((l: { actorId: string }) => l.actorId === staffId)).toBe(true);
  });
});
