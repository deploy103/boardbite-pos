import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner } from "./shared.js";

interface BackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * DB 백업(요구사항.md §13 "DB 백업/내보내기"). SQLite 파일을 통째로 복사하는 방식이라
 * 트래픽이 적은 시점(마감 직후 등)에 실행하는 것을 권장한다(docs/OPERATIONS.md §16 참고).
 */
export default function BackupsPanel() {
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [creating, setCreating] = useState(false);
  const { error, setError, wrap } = useErrorBanner();

  const refresh = () => api.get("/api/staff/admin/backups").then((d) => setBackups(d.backups));

  useEffect(() => {
    refresh().catch(() => setError("백업 목록을 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = wrap(async () => {
    setCreating(true);
    try {
      await api.post("/api/staff/admin/backups");
      await refresh();
    } finally {
      setCreating(false);
    }
  });

  return (
    <section>
      <p className="text-muted">
        서버의 데이터베이스 파일을 그대로 복사해 저장해요. 손님이 몰릴 때보다는 마감 직후처럼 한산한 시점에 만드는 것을
        권장해요.
      </p>
      <button className="btn-primary" style={{ width: 220 }} onClick={create} disabled={creating}>
        {creating ? "백업 만드는 중이에요..." : "백업 생성"}
      </button>
      {error && <p className="error-text">{error}</p>}

      {backups.length === 0 && <p className="text-muted" style={{ marginTop: 16 }}>아직 백업이 없어요.</p>}

      {backups.map((b) => (
        <div key={b.filename} className="list-row">
          <div>
            <strong>{b.filename}</strong>
            <div className="text-muted">
              {new Date(b.createdAt).toLocaleString()} · {formatSize(b.sizeBytes)}
            </div>
          </div>
          <a
            className="btn-secondary"
            style={{ textDecoration: "none" }}
            href={`/api/staff/admin/backups/${encodeURIComponent(b.filename)}`}
          >
            내려받기
          </a>
        </div>
      ))}
    </section>
  );
}
