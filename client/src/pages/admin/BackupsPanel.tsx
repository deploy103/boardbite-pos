import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { useErrorBanner, useStepUpGuard } from "./shared.js";
import StepUpModal from "../../components/StepUpModal.js";

interface BackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  checksum: string;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * DB 백업(요구사항.md §13 "DB 백업/내보내기"). SQLite 파일을 통째로 복사하는 방식이라
 * 트래픽이 적은 시점(마감 직후 등)에 실행하는 것을 권장한다(docs/OPERATIONS.md §16 참고).
 *
 * 백업 파일에는 전체 주문·결제 원장이 들어 있으므로 생성과 내려받기 모두 step-up 재인증이
 * 필요하다(요구사항2.md §2.5.2).
 */
export default function BackupsPanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [creating, setCreating] = useState(false);
  const { error, setError, wrap } = useErrorBanner();
  const { pending, setPending, guard } = useStepUpGuard();

  const refresh = () => api.get("/api/staff/admin/backups").then((d) => setBackups(d.backups));

  useEffect(() => {
    refresh().catch(() => setError("백업 목록을 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = wrap(async () => {
    await guard("DB 백업 생성", async () => {
      setCreating(true);
      try {
        await api.post("/api/staff/admin/backups");
        await refresh();
      } finally {
        setCreating(false);
      }
    });
  });

  /**
   * 내려받기는 브라우저가 직접 GET하므로 실패해도 JSON 403이 화면에 그대로 뜬다.
   * 그래서 이동 전에 현재 세션이 재인증 상태인지 먼저 확인하고, 아니면 확인 창을 띄운다.
   */
  const download = (filename: string) =>
    wrap(async () => {
      const url = `/api/staff/admin/backups/${encodeURIComponent(filename)}`;
      await guard("백업 파일 내려받기", async () => {
        const me = await api.get("/api/staff/me");
        if (!me.elevated) {
          // guard가 알아볼 수 있도록 서버와 같은 형태의 오류를 만들어 던진다.
          throw new ApiError("보안을 위해 비밀번호를 다시 확인해 주세요.", 403, "STEP_UP_REQUIRED");
        }
        window.location.href = url;
      });
    })();

  return (
    <section>
      <p className="text-muted">
        서버의 데이터베이스 파일을 그대로 복사해 저장해요. 손님이 몰릴 때보다는 마감 직후처럼 한산한 시점에 만드는 것을
        권장해요. 내려받은 파일에는 모든 주문·결제 기록이 들어 있으니 안전한 곳에 보관하세요.
      </p>
      <button className="btn-danger-outline" style={{ width: 220 }} onClick={create} disabled={creating}>
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
            {/* 복원한 파일이 원본과 같은지 확인할 수 있도록 체크섬을 함께 보여준다. */}
            <div className="text-muted" style={{ fontSize: "0.75rem", wordBreak: "break-all" }}>
              SHA-256 {b.checksum}
            </div>
          </div>
          <button className="btn-danger-outline" onClick={() => download(b.filename)}>
            내려받기
          </button>
        </div>
      ))}

      {pending && (
        <StepUpModal
          purpose={pending.purpose}
          mfaEnabled={mfaEnabled}
          onSuccess={() => {
            const retry = pending.retry;
            setPending(null);
            void retry().catch(() => setError("백업 작업을 완료하지 못했어요."));
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
