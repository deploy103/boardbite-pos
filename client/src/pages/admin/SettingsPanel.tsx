import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner } from "./shared.js";

type Settings = {
  orderingEnabled: boolean;
  paymentsEnabled: boolean;
  kdsWarnAfterSeconds: number;
  kdsDangerAfterSeconds: number;
  servedRevertWindowSeconds: number;
};

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [warnMinutes, setWarnMinutes] = useState("");
  const [dangerMinutes, setDangerMinutes] = useState("");
  const [revertSeconds, setRevertSeconds] = useState("");
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const { error, setError, wrap } = useErrorBanner();

  const applyToForm = (s: Settings) => {
    setSettings(s);
    setWarnMinutes(String(Math.round(s.kdsWarnAfterSeconds / 60)));
    setDangerMinutes(String(Math.round(s.kdsDangerAfterSeconds / 60)));
    setRevertSeconds(String(s.servedRevertWindowSeconds));
  };

  const refresh = () => api.get("/api/staff/admin/settings").then((d) => applyToForm(d.settings));
  useEffect(() => {
    refresh().catch(() => setError("운영 설정을 불러오지 못했어요."));
  }, []);

  const patch = (body: Partial<Settings>) =>
    wrap(async () => {
      setSavedMessage(null);
      const d = await api.patch("/api/staff/admin/settings", body);
      applyToForm(d.settings);
      setSavedMessage("저장했어요.");
    })();

  const toggleOrdering = () => settings && patch({ orderingEnabled: !settings.orderingEnabled });
  const togglePayments = () => settings && patch({ paymentsEnabled: !settings.paymentsEnabled });

  const saveKdsThresholds = () =>
    patch({
      kdsWarnAfterSeconds: Math.max(0, Number(warnMinutes) * 60),
      kdsDangerAfterSeconds: Math.max(0, Number(dangerMinutes) * 60),
    });

  const saveRevertWindow = () => patch({ servedRevertWindowSeconds: Math.max(0, Number(revertSeconds)) });

  if (!settings) {
    return (
      <section>
        {error && <p className="error-text">{error}</p>}
        {!error && <p className="text-muted">불러오는 중이에요...</p>}
      </section>
    );
  }

  return (
    <section>
      <h2>운영 모드</h2>
      <div className="list-row">
        <div>
          <strong>전체 주문 받기</strong>
          <div className="text-muted">끄면 모든 테이블에서 신규 주문을 받을 수 없어요.</div>
        </div>
        <button className="btn-secondary" onClick={toggleOrdering}>
          {settings.orderingEnabled ? "켜짐 · 끄기" : "꺼짐 · 켜기"}
        </button>
      </div>
      <div className="list-row">
        <div>
          <strong>전체 결제 받기</strong>
          <div className="text-muted">끄면 POS에서 결제를 진행할 수 없어요.</div>
        </div>
        <button className="btn-secondary" onClick={togglePayments}>
          {settings.paymentsEnabled ? "켜짐 · 끄기" : "꺼짐 · 켜기"}
        </button>
      </div>

      <h2 style={{ marginTop: 24 }}>KDS 지연 기준</h2>
      <p className="text-muted">임박 기준은 지연 기준보다 작아야 해요.</p>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field-label-group" style={{ maxWidth: 140 }}>
          <span className="field-label">임박 기준(분)</span>
          <input
            className="field"
            type="number"
            value={warnMinutes}
            onChange={(e) => setWarnMinutes(e.target.value)}
          />
        </label>
        <label className="field-label-group" style={{ maxWidth: 140 }}>
          <span className="field-label">지연 기준(분)</span>
          <input
            className="field"
            type="number"
            value={dangerMinutes}
            onChange={(e) => setDangerMinutes(e.target.value)}
          />
        </label>
        <button className="btn-secondary" onClick={saveKdsThresholds}>
          저장
        </button>
      </div>

      <h2 style={{ marginTop: 24 }}>서빙완료 되돌리기 허용 시간</h2>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label className="field-label-group" style={{ maxWidth: 140 }}>
          <span className="field-label">허용 시간(초)</span>
          <input
            className="field"
            type="number"
            value={revertSeconds}
            onChange={(e) => setRevertSeconds(e.target.value)}
          />
        </label>
        <button className="btn-secondary" onClick={saveRevertWindow}>
          저장
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {savedMessage && !error && <p className="text-muted">{savedMessage}</p>}
    </section>
  );
}
