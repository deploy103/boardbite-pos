import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useStaffMe } from "../lib/useStaffMe.js";
import ConnectionBanner from "../components/ConnectionBanner.js";
import StepUpModal from "../components/StepUpModal.js";
import DangerConfirmModal from "../components/DangerConfirmModal.js";
import {
  useErrorBanner,
  useStepUpGuard,
  minPasswordLength,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_STAFF_PASSWORD_LENGTH,
} from "./admin/shared.js";
import ClosingPanel from "./admin/ClosingPanel.js";
import PaymentMethodsPanel from "./admin/PaymentMethodsPanel.js";
import PaymentsPanel from "./admin/PaymentsPanel.js";
import RevenuePanel from "./admin/RevenuePanel.js";
import SettingsPanel from "./admin/SettingsPanel.js";
import BackupsPanel from "./admin/BackupsPanel.js";

type Tab =
  | "tables"
  | "menu"
  | "users"
  | "game-plans"
  | "logs"
  | "payment-methods"
  | "payments"
  | "revenue"
  | "settings"
  | "backups"
  | "closing";

export default function AdminHome() {
  const { me } = useStaffMe("ADMIN");
  const [tab, setTab] = useState<Tab>("tables");

  if (!me) return null;

  return (
    <div className="page page--wide">
      <ConnectionBanner />
      <h1>ADMIN</h1>
      <nav style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}>
        {(
          [
            "tables",
            "menu",
            "users",
            "game-plans",
            "logs",
            "payment-methods",
            "payments",
            "revenue",
            "settings",
            "backups",
            "closing",
          ] as Tab[]
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
            {t === "backups" && "백업"}
            {t === "closing" && "영업 마감"}
          </button>
        ))}
      </nav>
      {tab === "tables" && <TablesPanel mfaEnabled={me.mfaEnabled} />}
      {tab === "menu" && <MenuPanel />}
      {tab === "users" && <UsersPanel mfaEnabled={me.mfaEnabled} />}
      {tab === "game-plans" && <GamePlansPanel />}
      {tab === "logs" && <LogsPanel />}
      {tab === "payment-methods" && <PaymentMethodsPanel />}
      {tab === "payments" && <PaymentsPanel />}
      {tab === "revenue" && <RevenuePanel />}
      {tab === "settings" && <SettingsPanel />}
      {tab === "backups" && <BackupsPanel mfaEnabled={me.mfaEnabled} />}
      {tab === "closing" && <ClosingPanel mfaEnabled={me.mfaEnabled} />}
    </div>
  );
}

interface AdminTable {
  id: string;
  number: number;
  status: "DISABLED" | "AVAILABLE" | "OPEN" | "SETTLING";
  publicSlug: string;
  ordersLocked: boolean;
  paymentsLocked: boolean;
}

interface CloseBlocker {
  code: string;
  message: string;
  value: number;
}

function TablesPanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [number, setNumber] = useState("");
  const [forceTarget, setForceTarget] = useState<{ table: AdminTable; blockers: CloseBlocker[] } | null>(null);
  const { error, setError, wrap } = useErrorBanner();
  const { pending, setPending, guard } = useStepUpGuard();

  const refresh = () => api.get("/api/staff/admin/tables").then((d) => setTables(d.tables));
  useEffect(() => {
    refresh().catch(() => setError("테이블 목록을 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * 요구사항2.md §3.2 — status를 직접 PATCH하던 경로는 서버에서 제거됐다.
   * 사용 중지/재개는 전용 엔드포인트가 상태 머신을 통해 처리하며,
   * ACTIVE 세션이 있는 테이블은 서버가 409로 거절한다.
   */
  const setEnabled = (t: AdminTable, enabled: boolean) =>
    wrap(async () => {
      await api.post(`/api/staff/admin/tables/${t.id}/enabled`, { enabled });
      await refresh();
    })();

  const toggleOrdersLocked = (t: AdminTable) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/tables/${t.id}`, { ordersLocked: !t.ordersLocked });
      await refresh();
    })();

  const togglePaymentsLocked = (t: AdminTable) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/tables/${t.id}`, { paymentsLocked: !t.paymentsLocked });
      await refresh();
    })();

  /** 강제 종료 전에 무엇을 남긴 채 닫는지 먼저 보여준다. */
  const openForceClose = (t: AdminTable) =>
    wrap(async () => {
      const preview = await api.get(`/api/staff/admin/tables/${t.id}/force-close-preview`);
      setForceTarget({ table: t, blockers: preview.blockers });
    })();

  const confirmForceClose = (reason: string) =>
    wrap(async () => {
      const target = forceTarget;
      if (!target) return;
      setForceTarget(null);
      await guard("테이블 강제 종료", async () => {
        await api.post(`/api/staff/admin/tables/${target.table.id}/force-close`, { reason });
        await refresh();
      });
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
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        손님 입장에는 QR 주소와 별도로 <strong>이번 자리의 입장 코드</strong>가 필요합니다. 코드는 FRONT 화면에서 확인하세요.
      </p>
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
              QR 주소 재발급
            </button>
            {t.status === "DISABLED" ? (
              <button className="btn-secondary" onClick={() => setEnabled(t, true)}>
                사용 재개
              </button>
            ) : (
              <button className="btn-secondary" onClick={() => setEnabled(t, false)}>
                사용 중지
              </button>
            )}
            {(t.status === "OPEN" || t.status === "SETTLING") && (
              <button className="btn-danger-outline" onClick={() => openForceClose(t)}>
                강제 종료
              </button>
            )}
          </div>
        </div>
      ))}

      {forceTarget && (
        <DangerConfirmModal
          title={`${forceTarget.table.number}번 테이블 강제 종료`}
          description="정산이나 서빙이 끝나지 않았더라도 세션을 닫습니다. 이 작업은 취소할 수 없고, 남은 금액과 미서빙 주문 현황이 감사 로그에 그대로 기록됩니다."
          details={
            forceTarget.blockers.length > 0
              ? forceTarget.blockers.map((b) => ({ label: b.code, value: b.message }))
              : [{ label: "현재 상태", value: "막는 사유 없음 (일반 종료로도 닫을 수 있어요)" }]
          }
          requireReason
          reasonPlaceholder="강제 종료 사유 (필수, 기록에 남습니다)"
          confirmLabel="강제 종료하기"
          onConfirm={confirmForceClose}
          onCancel={() => setForceTarget(null)}
        />
      )}

      {pending && (
        <StepUpModal
          purpose={pending.purpose}
          mfaEnabled={mfaEnabled}
          onSuccess={() => {
            const retry = pending.retry;
            setPending(null);
            void retry().catch(() => setError("강제 종료 중 오류가 발생했어요."));
          }}
          onCancel={() => setPending(null)}
        />
      )}
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

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "FRONT" | "POS" | "SERVING";
  isActive: boolean;
  mustResetPassword: boolean;
  mfaEnabled: boolean;
  isBootstrap: boolean;
  lastLoginAt: string | null;
}

/**
 * 직원 계정 관리(요구사항2.md §9.2).
 *
 * role 변경 / 비활성화 / 비밀번호 초기화 / MFA 해제는 전부 고위험 작업이라 서버가 step-up
 * 재인증을 요구하고, 성공 시 대상 계정의 authVersion이 올라가 기존 세션이 즉시 끊긴다.
 */
function UsersPanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [form, setForm] = useState({ username: "", password: "", displayName: "", role: "FRONT" });
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const { error, setError, wrap } = useErrorBanner();
  const { pending, setPending, guard } = useStepUpGuard();

  const refresh = () => api.get("/api/staff/admin/users").then((d) => setUsers(d.users));
  useEffect(() => {
    refresh().catch(() => setError("사용자 목록을 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 직원 계정은 이 화면에서만 만들어진다(시드는 부트스트랩 ADMIN 하나만 생성한다).
  // ADMIN 역할 생성은 권한 상승이라 서버가 step-up을 요구하므로 guard로 감싼다 —
  // 서버가 403 STEP_UP_REQUIRED를 주면 재인증 창이 뜨고 같은 요청이 그대로 재시도된다.
  const create = wrap(async () => {
    setNotice(null);
    await guard(`${form.role} 계정 생성`, async () => {
      await api.post("/api/staff/admin/users", form);
      setForm({ username: "", password: "", displayName: "", role: "FRONT" });
      setNotice("계정을 만들었어요. 첫 로그인 시 본인이 비밀번호를 바꾸도록 안내해 주세요.");
      await refresh();
    });
  });

  const toggleActive = (u: AdminUser) =>
    wrap(async () => {
      setNotice(null);
      await guard(u.isActive ? `${u.displayName} 계정 비활성화` : `${u.displayName} 계정 활성화`, async () => {
        await api.patch(`/api/staff/admin/users/${u.id}`, { isActive: !u.isActive });
        setNotice(
          u.isActive
            ? `${u.displayName} 계정을 비활성화했어요. 로그인되어 있던 기기는 즉시 로그아웃됩니다.`
            : `${u.displayName} 계정을 다시 활성화했어요.`,
        );
        await refresh();
      });
    })();

  const changeRole = (u: AdminUser, role: string) =>
    wrap(async () => {
      if (role === u.role) return;
      setNotice(null);
      await guard(`${u.displayName} 권한 변경`, async () => {
        await api.patch(`/api/staff/admin/users/${u.id}`, { role });
        setNotice(`${u.displayName}의 권한을 ${role}로 바꿨어요. 기존 로그인 세션은 즉시 무효화됩니다.`);
        await refresh();
      });
    })();

  const disableMfa = (u: AdminUser) =>
    wrap(async () => {
      setNotice(null);
      await guard(`${u.displayName} 2단계 인증 해제`, async () => {
        await api.post(`/api/staff/admin/users/${u.id}/disable-mfa`, {});
        setNotice(`${u.displayName}의 2단계 인증을 해제했어요. 다음 로그인에서 다시 설정해야 합니다.`);
        await refresh();
      });
    })();

  const submitReset = wrap(async () => {
    const target = resetTarget;
    if (!target || !resetPassword) return;
    setNotice(null);
    await guard(`${target.displayName} 비밀번호 초기화`, async () => {
      await api.post(`/api/staff/admin/users/${target.id}/reset-password`, { newPassword: resetPassword });
      setResetTarget(null);
      setResetPassword("");
      setNotice(`${target.displayName}의 비밀번호를 초기화했어요. 본인이 로그인하면 바로 변경하게 됩니다.`);
      await refresh();
    });
  });

  return (
    <section>
      <h2>직원 계정 추가</h2>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        FRONT/POS/SERVING 계정은 이 화면에서만 만들 수 있습니다. 공용 계정 대신 개인별 계정을
        권장합니다 — 감사 로그에 누가 한 작업인지 그대로 남아요.
      </p>
      <input className="field" placeholder="아이디" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
      <input
        className="field"
        placeholder={`초기 비밀번호 (${minPasswordLength(form.role)}자 이상)`}
        type="password"
        minLength={minPasswordLength(form.role)}
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
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        {form.role === "ADMIN"
          ? `관리자 계정은 비밀번호 ${MIN_ADMIN_PASSWORD_LENGTH}자 이상 + 2단계 인증(TOTP) 등록을 마쳐야 관리 기능이 열립니다. 생성하려면 본인 확인이 한 번 더 필요해요.`
          : `직원 계정은 비밀번호 ${MIN_STAFF_PASSWORD_LENGTH}자 이상이면 됩니다. 2단계 인증은 선택이며, 등록 여부는 아래 목록의 배지로 확인할 수 있어요.`}
      </p>
      <button className="btn-primary" onClick={create}>
        계정 생성
      </button>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="text-muted">{notice}</p>}

      {users.map((u) => (
        <div key={u.id} className="list-row">
          <div>
            <strong>{u.displayName}</strong> ({u.username}) · <span className="badge">{u.role}</span>{" "}
            {!u.isActive && <span className="badge badge--danger">비활성</span>}{" "}
            {u.mustResetPassword && <span className="badge badge--warn">비밀번호 변경 필요</span>}{" "}
            {u.mfaEnabled ? <span className="badge">MFA 사용</span> : <span className="badge badge--warn">MFA 없음</span>}{" "}
            {u.isBootstrap && <span className="badge badge--warn">부트스트랩 계정</span>}
            <div className="text-muted">
              마지막 로그인: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("ko-KR") : "기록 없음"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select className="field" style={{ width: 130, margin: 0 }} value={u.role} onChange={(e) => changeRole(u, e.target.value)}>
              <option value="FRONT">FRONT</option>
              <option value="POS">POS</option>
              <option value="SERVING">SERVING</option>
              <option value="ADMIN">ADMIN</option>
            </select>
            <button className="btn-danger-outline" onClick={() => setResetTarget(u)}>
              비밀번호 초기화
            </button>
            {u.mfaEnabled && (
              <button className="btn-danger-outline" onClick={() => disableMfa(u)}>
                MFA 해제
              </button>
            )}
            <button className={u.isActive ? "btn-danger-outline" : "btn-secondary"} onClick={() => toggleActive(u)}>
              {u.isActive ? "비활성화" : "활성화"}
            </button>
          </div>
        </div>
      ))}

      {resetTarget && (
        <div className="sheet-overlay" onClick={() => setResetTarget(null)}>
          <div className="sheet danger-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-header">
              <h2 className="sheet-title danger-title">{resetTarget.displayName} 비밀번호 초기화</h2>
              <button type="button" className="sheet-close" onClick={() => setResetTarget(null)}>
                닫기
              </button>
            </div>
            <p className="sheet-desc">
              초기화하면 이 계정의 모든 기기가 즉시 로그아웃되고, 본인이 로그인할 때 새 비밀번호를 정하게 됩니다.
              임시 비밀번호는 안전한 방법으로 직접 전달해 주세요.
            </p>
            <input
              className="field"
              type="password"
              placeholder={`임시 비밀번호 (${minPasswordLength(resetTarget.role)}자 이상)`}
              minLength={minPasswordLength(resetTarget.role)}
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              autoFocus
            />
            <button className="btn-danger" onClick={submitReset} disabled={!resetPassword}>
              초기화하기
            </button>
          </div>
        </div>
      )}

      {pending && (
        <StepUpModal
          purpose={pending.purpose}
          mfaEnabled={mfaEnabled}
          onSuccess={() => {
            const retry = pending.retry;
            setPending(null);
            void retry().catch(() => setError("작업을 완료하지 못했어요."));
          }}
          onCancel={() => setPending(null)}
        />
      )}
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
