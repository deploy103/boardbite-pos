import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useStaffMe } from "../lib/useStaffMe.js";
import { useErrorBanner } from "./admin/shared.js";
import PaymentMethodsPanel from "./admin/PaymentMethodsPanel.js";
import PaymentsPanel from "./admin/PaymentsPanel.js";
import RevenuePanel from "./admin/RevenuePanel.js";
import SettingsPanel from "./admin/SettingsPanel.js";

type Tab = "tables" | "menu" | "users" | "game-plans" | "logs" | "payment-methods" | "payments" | "revenue" | "settings";

export default function AdminHome() {
  const { me } = useStaffMe("ADMIN");
  const [tab, setTab] = useState<Tab>("tables");

  if (!me) return null;

  return (
    <div className="page page--wide">
      <h1>ADMIN</h1>
      <nav style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}>
        {(
          ["tables", "menu", "users", "game-plans", "logs", "payment-methods", "payments", "revenue", "settings"] as Tab[]
        ).map((t) => (
          <button key={t} className="btn-secondary" onClick={() => setTab(t)} disabled={tab === t}>
            {t === "tables" && "테이블"}
            {t === "menu" && "메뉴"}
            {t === "users" && "사용자"}
            {t === "game-plans" && "이용권"}
            {t === "logs" && "감사 로그"}
            {t === "payment-methods" && "결제수단"}
            {t === "payments" && "결제내역"}
            {t === "revenue" && "매출현황"}
            {t === "settings" && "운영설정"}
          </button>
        ))}
      </nav>
      {tab === "tables" && <TablesPanel />}
      {tab === "menu" && <MenuPanel />}
      {tab === "users" && <UsersPanel />}
      {tab === "game-plans" && <GamePlansPanel />}
      {tab === "logs" && <LogsPanel />}
      {tab === "payment-methods" && <PaymentMethodsPanel />}
      {tab === "payments" && <PaymentsPanel />}
      {tab === "revenue" && <RevenuePanel />}
      {tab === "settings" && <SettingsPanel />}
    </div>
  );
}

function TablesPanel() {
  const [tables, setTables] = useState<any[]>([]);
  const [number, setNumber] = useState("");
  const { error, setError, wrap } = useErrorBanner();

  const refresh = () => api.get("/api/staff/admin/tables").then((d) => setTables(d.tables));
  useEffect(() => {
    refresh().catch(() => setError("테이블 목록을 불러오지 못했어요."));
  }, []);

  const create = wrap(async () => {
    if (!number) return;
    await api.post("/api/staff/admin/tables", { number: Number(number) });
    setNumber("");
    await refresh();
  });

  const rotate = (id: string) =>
    wrap(async () => {
      await api.post(`/api/staff/admin/tables/${id}/rotate-slug`);
      await refresh();
    })();

  const disable = (id: string) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/tables/${id}`, { status: "DISABLED" });
      await refresh();
    })();

  const toggleOrdersLocked = (t: any) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/tables/${t.id}`, { ordersLocked: !t.ordersLocked });
      await refresh();
    })();

  const togglePaymentsLocked = (t: any) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/tables/${t.id}`, { paymentsLocked: !t.paymentsLocked });
      await refresh();
    })();

  return (
    <section>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="field" placeholder="테이블 번호" value={number} onChange={(e) => setNumber(e.target.value)} />
        <button className="btn-primary" style={{ width: 160 }} onClick={create}>
          테이블 추가
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {tables.map((t) => (
        <div key={t.id} className="list-row">
          <div>
            <strong>{t.number}번</strong> · <span className="badge">{t.status}</span>{" "}
            {t.ordersLocked && <span className="badge badge--warn">주문 잠금</span>}{" "}
            {t.paymentsLocked && <span className="badge badge--warn">결제 잠금</span>}
            <div className="text-muted">주문 URL: /t/{t.publicSlug}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-secondary" onClick={() => toggleOrdersLocked(t)}>
              {t.ordersLocked ? "주문 잠금 해제" : "주문 잠금"}
            </button>
            <button className="btn-secondary" onClick={() => togglePaymentsLocked(t)}>
              {t.paymentsLocked ? "결제 잠금 해제" : "결제 잠금"}
            </button>
            <button className="btn-secondary" onClick={() => rotate(t.id)}>
              토큰 회전
            </button>
            <button className="btn-secondary" onClick={() => disable(t.id)}>
              비활성화
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function MenuPanel() {
  const [categories, setCategories] = useState<any[]>([]);
  const [catName, setCatName] = useState("");
  const [itemForm, setItemForm] = useState({ categoryId: "", name: "", price: "" });
  const { error, setError, wrap } = useErrorBanner();

  const refresh = () => api.get("/api/staff/admin/menu/categories").then((d) => setCategories(d.categories));
  useEffect(() => {
    refresh().catch(() => setError("메뉴를 불러오지 못했어요."));
  }, []);

  const addCategory = wrap(async () => {
    if (!catName) return;
    await api.post("/api/staff/admin/menu/categories", { name: catName });
    setCatName("");
    await refresh();
  });

  const addItem = wrap(async () => {
    if (!itemForm.categoryId || !itemForm.name || !itemForm.price) return;
    await api.post("/api/staff/admin/menu/items", {
      categoryId: itemForm.categoryId,
      name: itemForm.name,
      price: Number(itemForm.price),
    });
    setItemForm({ categoryId: itemForm.categoryId, name: "", price: "" });
    await refresh();
  });

  const toggleSoldOut = (id: string, current: boolean) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/menu/items/${id}`, { isSoldOut: !current });
      await refresh();
    })();

  return (
    <section>
      <h2>카테고리</h2>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="field" placeholder="카테고리명" value={catName} onChange={(e) => setCatName(e.target.value)} />
        <button className="btn-primary" style={{ width: 160 }} onClick={addCategory}>
          추가
        </button>
      </div>

      <h2 style={{ marginTop: 24 }}>메뉴 추가</h2>
      <select
        className="field"
        value={itemForm.categoryId}
        onChange={(e) => setItemForm({ ...itemForm, categoryId: e.target.value })}
      >
        <option value="">카테고리 선택</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input
        className="field"
        placeholder="메뉴명"
        value={itemForm.name}
        onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
      />
      <input
        className="field"
        placeholder="가격(원)"
        type="number"
        value={itemForm.price}
        onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })}
      />
      <button className="btn-primary" onClick={addItem}>
        메뉴 추가
      </button>

      {error && <p className="error-text">{error}</p>}

      {categories.map((c) => (
        <div key={c.id} style={{ marginTop: 24 }}>
          <h3>{c.name}</h3>
          {c.items.map((item: any) => (
            <div key={item.id} className={`list-row ${item.isSoldOut ? "list-row--disabled" : ""}`}>
              <div>
                {item.name} · {item.price.toLocaleString()}원 {item.isSoldOut && <span className="badge badge--danger">품절</span>}
              </div>
              <button className="btn-secondary" onClick={() => toggleSoldOut(item.id, item.isSoldOut)}>
                {item.isSoldOut ? "품절 해제" : "품절 처리"}
              </button>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function UsersPanel() {
  const [users, setUsers] = useState<any[]>([]);
  const [form, setForm] = useState({ username: "", password: "", displayName: "", role: "FRONT" });
  const { error, setError, wrap } = useErrorBanner();

  const refresh = () => api.get("/api/staff/admin/users").then((d) => setUsers(d.users));
  useEffect(() => {
    refresh().catch(() => setError("사용자 목록을 불러오지 못했어요."));
  }, []);

  const create = wrap(async () => {
    await api.post("/api/staff/admin/users", form);
    setForm({ username: "", password: "", displayName: "", role: "FRONT" });
    await refresh();
  });

  const toggleActive = (id: string, current: boolean) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/users/${id}`, { isActive: !current });
      await refresh();
    })();

  return (
    <section>
      <h2>직원 계정 추가</h2>
      <input className="field" placeholder="아이디" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
      <input
        className="field"
        placeholder="초기 비밀번호(8자 이상)"
        type="password"
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
      />
      <input
        className="field"
        placeholder="표시 이름"
        value={form.displayName}
        onChange={(e) => setForm({ ...form, displayName: e.target.value })}
      />
      <select className="field" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
        <option value="FRONT">FRONT</option>
        <option value="POS">POS</option>
        <option value="SERVING">SERVING</option>
        <option value="ADMIN">ADMIN</option>
      </select>
      <button className="btn-primary" onClick={create}>
        계정 생성
      </button>
      {error && <p className="error-text">{error}</p>}

      {users.map((u) => (
        <div key={u.id} className="list-row">
          <div>
            {u.displayName} ({u.username}) · <span className="badge">{u.role}</span>{" "}
            {!u.isActive && <span className="badge badge--danger">비활성</span>}
          </div>
          <button className="btn-secondary" onClick={() => toggleActive(u.id, u.isActive)}>
            {u.isActive ? "비활성화" : "활성화"}
          </button>
        </div>
      ))}
    </section>
  );
}

function GamePlansPanel() {
  const [plans, setPlans] = useState<any[]>([]);
  const [form, setForm] = useState({ name: "", minutes: "", price: "" });
  const { error, setError, wrap } = useErrorBanner();

  const refresh = () => api.get("/api/staff/admin/game-plans").then((d) => setPlans(d.plans));
  useEffect(() => {
    refresh().catch(() => setError("이용권 목록을 불러오지 못했어요."));
  }, []);

  const create = wrap(async () => {
    await api.post("/api/staff/admin/game-plans", {
      name: form.name,
      minutes: Number(form.minutes),
      price: Number(form.price),
    });
    setForm({ name: "", minutes: "", price: "" });
    await refresh();
  });

  return (
    <section>
      <h2>이용권 추가</h2>
      <input className="field" placeholder="이름(예: 20분)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input
        className="field"
        placeholder="분"
        type="number"
        value={form.minutes}
        onChange={(e) => setForm({ ...form, minutes: e.target.value })}
      />
      <input
        className="field"
        placeholder="가격(원)"
        type="number"
        value={form.price}
        onChange={(e) => setForm({ ...form, price: e.target.value })}
      />
      <button className="btn-primary" onClick={create}>
        추가
      </button>
      {error && <p className="error-text">{error}</p>}
      {plans.map((p) => (
        <div key={p.id} className="list-row">
          <div>
            {p.name} · {p.minutes}분 · {p.price.toLocaleString()}원
          </div>
        </div>
      ))}
    </section>
  );
}

function LogsPanel() {
  const [logs, setLogs] = useState<any[]>([]);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [purgeBeforeDate, setPurgeBeforeDate] = useState("");
  const [purgeResult, setPurgeResult] = useState<string | null>(null);
  const { error, setError, wrap } = useErrorBanner();

  function buildQuery() {
    const params = new URLSearchParams();
    if (actionFilter) params.set("action", actionFilter);
    if (since) params.set("since", new Date(since).toISOString());
    if (until) params.set("until", new Date(until).toISOString());
    return params.toString();
  }

  const search = wrap(async () => {
    const data = await api.get(`/api/staff/admin/audit-logs?${buildQuery()}`);
    setLogs(data.logs);
  });

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async () => {
    const result = await api.get("/api/staff/admin/audit-logs/verify");
    setVerifyResult(result.ok ? "무결성 검증 통과: 변조 흔적이 없습니다." : `무결성 오류 발견: ${result.brokenAt}`);
  };

  const purge = wrap(async () => {
    if (!purgeBeforeDate) return;
    const dateLabel = new Date(purgeBeforeDate).toLocaleString();
    if (!window.confirm(`${dateLabel} 이전의 로그를 정말 삭제할까요? 이 작업은 되돌릴 수 없어요.`)) return;
    if (!window.confirm("한 번 더 확인할게요. 정말 삭제할까요?")) return;
    const result = await api.post("/api/staff/admin/audit-logs/purge", {
      beforeDate: new Date(purgeBeforeDate).toISOString(),
      confirm: true,
    });
    setPurgeResult(`${result.result.deletedCount}건을 삭제했어요.`);
    await search();
  });

  return (
    <section>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input className="field" style={{ marginBottom: 0 }} placeholder="액션(예: PAYMENT_CREATED)" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} />
        <input className="field" style={{ marginBottom: 0 }} type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
        <input className="field" style={{ marginBottom: 0 }} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        <button className="btn-secondary" onClick={search}>
          검색
        </button>
        <a className="btn-secondary" href={`/api/staff/admin/export/audit-logs.csv?${buildQuery()}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
          CSV 내보내기
        </a>
        <button className="btn-secondary" onClick={verify}>
          해시체인 무결성 검증
        </button>
      </div>
      {verifyResult && <p className="text-muted">{verifyResult}</p>}
      {error && <p className="error-text">{error}</p>}

      <div className="list-row" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="text-muted">이 날짜 이전 로그 정리(삭제)</div>
          <input className="field" type="datetime-local" value={purgeBeforeDate} onChange={(e) => setPurgeBeforeDate(e.target.value)} />
        </div>
        <button className="btn-secondary" onClick={purge} disabled={!purgeBeforeDate}>
          정리 실행
        </button>
      </div>
      {purgeResult && <p className="text-muted">{purgeResult}</p>}

      {logs.map((log) => (
        <div key={log.id} className="list-row">
          <div>
            <strong>{log.action}</strong> · {new Date(log.createdAt).toLocaleString()}
            {log.targetType && (
              <div className="text-muted">
                {log.targetType} #{log.targetId}
              </div>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
