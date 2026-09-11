import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordAuditLog } from "./auditLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "../..");
const backupsDir = path.join(serverRoot, "backups");

/** DATABASE_URL(file:./dev.db?connection_limit=1)에서 실제 파일 경로를 뽑아낸다. */
function resolveDbFilePath(): string {
  const raw = process.env.DATABASE_URL ?? "";
  const withoutScheme = raw.replace(/^file:/, "");
  const withoutQuery = withoutScheme.split("?")[0];
  return path.resolve(serverRoot, "prisma", withoutQuery);
}

export interface BackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * SQLite 파일을 통째로 복사하는 방식의 백업. 학교 부스 규모(저트래픽, 단일 프로세스,
 * connection_limit=1)에서는 충분히 안전하지만, 이론적으로 복사 도중 쓰기가 겹치면
 * 파일이 일부만 반영될 위험이 있다 — 한산한 시점(마감 직후 등)에 실행할 것을 권장한다.
 * docs/OPERATIONS.md 백업 절차 참고.
 */
export async function createBackup(staffId: string | undefined | null): Promise<BackupFile> {
  if (!existsSync(backupsDir)) {
    mkdirSync(backupsDir, { recursive: true });
  }

  const dbPath = resolveDbFilePath();
  if (!existsSync(dbPath)) {
    throw new Error(`DB 파일을 찾을 수 없어요: ${dbPath}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `boardbite-${timestamp}.db`;
  const destPath = path.join(backupsDir, filename);

  copyFileSync(dbPath, destPath);

  const stats = statSync(destPath);

  await recordAuditLog({
    actorType: "STAFF",
    actorId: staffId,
    action: "DB_BACKUP_CREATED",
    metadata: { filename, sizeBytes: stats.size },
  });

  return { filename, sizeBytes: stats.size, createdAt: new Date().toISOString() };
}

export function listBackups(): BackupFile[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((f) => f.endsWith(".db"))
    .map((filename) => {
      const stats = statSync(path.join(backupsDir, filename));
      return { filename, sizeBytes: stats.size, createdAt: stats.birthtime.toISOString() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getBackupFilePath(filename: string): string | null {
  // Path traversal 방지: 파일명에 경로 구분자가 없어야 하고 백업 디렉터리 안의 실제 파일이어야 한다.
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
  const fullPath = path.join(backupsDir, filename);
  if (!existsSync(fullPath)) return null;
  return fullPath;
}
