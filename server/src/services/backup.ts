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

// 생성 시 파일명 형식: `boardbite-${new Date().toISOString().replace(/[:.]/g, "-")}.db`
// 예: 2026-09-11T14:32:50.593Z → boardbite-2026-09-11T14-32-50-593Z.db
const FILENAME_TIMESTAMP_RE = /^boardbite-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;

/**
 * 파일명에서 생성 시각을 복원한다. `fs.Stats.birthtime`은 WSL의 DrvFs(`/mnt/c/...`) 등
 * 일부 파일시스템에서 지원되지 않아 항상 1970-01-01을 반환하는 경우가 있어, 더 신뢰할 수 있는
 * 파일명 기반 방식을 우선 사용하고 실패하면 mtime으로 대체한다(백업 파일은 생성 후 다시 수정되지
 * 않으므로 mtime도 사실상 생성시각과 같다).
 */
function resolveCreatedAt(filename: string, stats: { mtime: Date }): string {
  const match = filename.match(FILENAME_TIMESTAMP_RE);
  if (match) {
    const [, datePart, hh, mm, ss, ms] = match;
    const parsed = new Date(`${datePart}T${hh}:${mm}:${ss}.${ms}Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return stats.mtime.toISOString();
}

export function listBackups(): BackupFile[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((f) => f.endsWith(".db"))
    .map((filename) => {
      const stats = statSync(path.join(backupsDir, filename));
      return { filename, sizeBytes: stats.size, createdAt: resolveCreatedAt(filename, stats) };
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
