import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner } from "./shared.js";

type PaymentMethod = {
  id: string;
  code: string;
  name: string;
  isCash: boolean;
  isActive: boolean;
  sortOrder: number;
};

export default function PaymentMethodsPanel() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [form, setForm] = useState({ code: "", name: "", sortOrder: "" });
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const { error, setError, wrap } = useErrorBanner();

  const refresh = () => api.get("/api/staff/admin/payment-methods").then((d) => setMethods(d.methods));
  useEffect(() => {
    refresh().catch(() => setError("결제수단 목록을 불러오지 못했어요."));
  }, []);

  const create = wrap(async () => {
    if (!form.code || !form.name) return;
    await api.post("/api/staff/admin/payment-methods", {
      code: form.code.toUpperCase(),
      name: form.name,
      ...(form.sortOrder ? { sortOrder: Number(form.sortOrder) } : {}),
    });
    setForm({ code: "", name: "", sortOrder: "" });
    await refresh();
  });

  const toggleActive = (m: PaymentMethod) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/payment-methods/${m.id}`, { isActive: !m.isActive });
      await refresh();
    })();

  const rename = (m: PaymentMethod) =>
    wrap(async () => {
      const nextName = renameDrafts[m.id];
      if (!nextName || nextName === m.name) return;
      await api.patch(`/api/staff/admin/payment-methods/${m.id}`, { name: nextName });
      await refresh();
    })();

  return (
    <section>
      <h2>결제수단 추가</h2>
      <p className="text-muted">코드는 영문 대문자/숫자/밑줄만 사용해요 (예: TOSS_PAY). 새로 만든 결제수단은 현금이 아닌 것으로 등록돼요.</p>
      <input
        className="field"
        placeholder="코드 (예: TOSS_PAY)"
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
      />
      <input
        className="field"
        placeholder="이름 (예: 토스페이)"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <input
        className="field"
        placeholder="정렬순서(선택)"
        type="number"
        value={form.sortOrder}
        onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
      />
      <button className="btn-primary" onClick={create}>
        결제수단 추가
      </button>

      {error && <p className="error-text">{error}</p>}

      {methods.map((m) => {
        const cashLocked = m.code === "CASH" && m.isActive;
        return (
          <div key={m.id} className="list-row">
            <div>
              <strong>{m.name}</strong> · <span className="text-muted">{m.code}</span>{" "}
              {m.isCash && <span className="badge">현금</span>}{" "}
              {!m.isActive && <span className="badge badge--danger">비활성</span>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  className="field"
                  style={{ marginBottom: 0, minHeight: 36 }}
                  placeholder="새 이름"
                  value={renameDrafts[m.id] ?? ""}
                  onChange={(e) => setRenameDrafts({ ...renameDrafts, [m.id]: e.target.value })}
                />
                <button className="btn-secondary" onClick={() => rename(m)}>
                  이름 저장
                </button>
              </div>
            </div>
            <button
              className="btn-secondary"
              onClick={() => toggleActive(m)}
              disabled={cashLocked}
              title={cashLocked ? "기본 현금 결제수단은 비활성화할 수 없어요." : undefined}
            >
              {m.isActive ? "비활성화" : "활성화"}
            </button>
          </div>
        );
      })}
    </section>
  );
}
