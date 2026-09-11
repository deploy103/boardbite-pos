import { prisma } from "../prisma.js";
import { recordAuditLog } from "./auditLog.js";

const SETTINGS_ID = 1;

const DEFAULTS = {
  id: SETTINGS_ID,
  orderingEnabled: true,
  paymentsEnabled: true,
  kdsWarnAfterSeconds: 300,
  kdsDangerAfterSeconds: 600,
  servedRevertWindowSeconds: 180,
} as const;

/**
 * 운영 설정은 싱글턴 행 하나로 관리한다(요구사항.md §13 "운영 설정").
 * KDS 지연 기준, 서빙 되돌리기 허용 시간, 주문/결제 전체 잠금 등 "하드코딩하면 안 되는" 값들을
 * 전부 이 테이블에서 읽어온다.
 */
export async function getSettings() {
  const existing = await prisma.operationSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (existing) return existing;
  return prisma.operationSettings.create({ data: DEFAULTS });
}

export interface UpdateSettingsInput {
  orderingEnabled?: boolean;
  paymentsEnabled?: boolean;
  kdsWarnAfterSeconds?: number;
  kdsDangerAfterSeconds?: number;
  servedRevertWindowSeconds?: number;
}

export async function updateSettings(input: UpdateSettingsInput, staffId: string) {
  await getSettings(); // 행이 없으면 먼저 생성
  const before = await prisma.operationSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
  const updated = await prisma.operationSettings.update({ where: { id: SETTINGS_ID }, data: input });

  if (input.paymentsEnabled !== undefined && input.paymentsEnabled !== before.paymentsEnabled) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: staffId,
      action: "SYSTEM_PAYMENT_DISABLED",
      targetType: "OperationSettings",
      metadata: { paymentsEnabled: input.paymentsEnabled },
    });
  }
  if (input.orderingEnabled !== undefined && input.orderingEnabled !== before.orderingEnabled) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: staffId,
      action: "SYSTEM_ORDERING_TOGGLED",
      targetType: "OperationSettings",
      metadata: { orderingEnabled: input.orderingEnabled },
    });
  }
  const settingsChanged = Object.keys(input).some(
    (key) => key !== "paymentsEnabled" && key !== "orderingEnabled",
  );
  if (settingsChanged) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: staffId,
      action: "SETTINGS_UPDATED",
      targetType: "OperationSettings",
      metadata: input as Record<string, unknown>,
    });
  }

  return updated;
}
