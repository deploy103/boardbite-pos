import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../prisma.js";
import { recordAuditLog } from "./auditLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "../..");
const backupsDir = path.join(serverRoot, "backups");

/** 보관할 최대 백업 개수. 초과분은 오래된 것부터 자동 삭제한다. */
const MAX_BACKUPS = 20;

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
  /** SHA-256 hex. 복원 전에 파일이 온전한지 대조하는 용도(요구사항2.md §5.1). */
  checksum: string;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * SQLite `VACUUM INTO`로 백업한다.
 *
 * 기존 `copyFileSync()`는 WAL/저널이 반영되지 않은 시점의 파일을 그대로 복사하므로, 쓰기가
 * 겹치면 일부만 반영된(찢어진) 파일이 나올 수 있었다. `VACUUM INTO`는 SQLite가 직접 일관된
 * 스냅샷을 새 파일로 기록하는 공식 백업 수단이라 영업 중에 실행해도 안전하다
 * (요구사항2.md §5.1).
 *
 * 경로는 SQL 문자열에 들어가므로 우리가 만든 타임스탬프 파일명만 사용하고, 작은따옴표는
 * SQLite 규칙대로 이스케이프한다(파일명은 서버가 생성하므로 외부 입력이 섞이지 않는다).
 */
export async function createBackup(staffId: string | undefined | null): Promise<BackupFile> {
  if (!existsSync(backupsDir)) {
    mkdirSync(backupsDir, { recursive: true });
  }

  const dbPath = resolveDbFilePath();
  if (!existsSync(dbPath)) {
    throw new Error("데이터베이스 파일을 찾을 수 없어요. 서버 설정을 확인해 주세요.");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `boardbite-${timestamp}.db`;
  const destPath = path.join(backupsDir, filename);

  if (existsSync(destPath)) {
    // VACUUM INTO는 대상 파일이 이미 있으면 실패한다 — 같은 밀리초 재요청 방어.
    throw new Error("같은 이름의 백업이 이미 있어요. 잠시 후 다시 시도해 주세요.");
  }

  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } catch (err) {
    // 실패 시 부분 파일이 남지 않도록 정리한다.
    if (existsSync(destPath)) rmSync(destPath, { force: true });
    throw new Error(`백업에 실패했어요: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
  }

  if (!existsSync(destPath)) {
    throw new Error("백업 파일이 생성되지 않았어요.");
  }

  const stats = statSync(destPath);
  const checksum = await sha256File(destPath);

  pruneOldBackups();

  await recordAuditLog({
    actorType: "STAFF",
    actorId: staffId,
    action: "DB_BACKUP_CREATED",
    metadata: { filename, sizeBytes: stats.size, checksum },
  });

  return { filename, sizeBytes: stats.size, createdAt: new Date().toISOString(), checksum };
}

/** 최근 MAX_BACKUPS개만 남기고 오래된 백업을 지운다. */
function pruneOldBackups(): void {
  const files = readdirSync(backupsDir)
    .filter((f) => f.endsWith(".db"))
    .map((filename) => ({ filename, createdAt: resolveCreatedAt(filename, statSync(path.join(backupsDir, filename))) }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  for (const file of files.slice(MAX_BACKUPS)) {
    rmSync(path.join(backupsDir, file.filename), { force: true });
  }
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

export async function listBackups(): Promise<BackupFile[]> {
  if (!existsSync(backupsDir)) return [];
  const entries = readdirSync(backupsDir).filter((f) => f.endsWith(".db"));
  const files = await Promise.all(
    entries.map(async (filename) => {
      const fullPath = path.join(backupsDir, filename);
      const stats = statSync(fullPath);
      return {
        filename,
        sizeBytes: stats.size,
        createdAt: resolveCreatedAt(filename, stats),
        checksum: await sha256File(fullPath),
      };
    }),
  );
  return files.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getBackupFilePath(filename: string): string | null {
  // Path traversal 방지: 우리가 만든 파일명 형식에 정확히 일치해야 하고, 정규화한 경로가
  // 백업 디렉터리 안에 있어야 한다(심볼릭 링크/상대경로 우회 차단).
  if (!FILENAME_TIMESTAMP_RE.test(filename)) return null;
  const fullPath = path.resolve(backupsDir, filename);
  if (path.dirname(fullPath) !== path.resolve(backupsDir)) return null;
  if (!existsSync(fullPath)) return null;
  return fullPath;
}
