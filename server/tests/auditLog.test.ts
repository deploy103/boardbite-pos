import { describe, it, expect } from "vitest";
import { recordAuditLog, verifyAuditLogChain } from "../src/services/auditLog.js";
import { prisma } from "../src/prisma.js";

describe("감사 로그 해시체인", () => {
  it("정상적으로 쌓인 로그는 무결성 검증을 통과한다", async () => {
    await recordAuditLog({ actorType: "SYSTEM", action: "TEST_EVENT_1" });
    await recordAuditLog({ actorType: "SYSTEM", action: "TEST_EVENT_2", metadata: { foo: "bar" } });

    const brokenAt = await verifyAuditLogChain();
    expect(brokenAt).toBeNull();
  });

  it("중간 레코드가 변조되면 무결성 검증이 실패를 감지한다", async () => {
    await recordAuditLog({ actorType: "SYSTEM", action: "TEST_EVENT_TAMPER" });
    const target = await prisma.auditLog.findFirst({
      where: { action: "TEST_EVENT_TAMPER" },
      orderBy: { createdAt: "desc" },
    });
    expect(target).not.toBeNull();

    await prisma.auditLog.update({ where: { id: target!.id }, data: { action: "TAMPERED" } });

    const brokenAt = await verifyAuditLogChain();
    expect(brokenAt).toBe(target!.id);
  });
});
