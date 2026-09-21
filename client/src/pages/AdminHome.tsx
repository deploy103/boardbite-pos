import { useEffect, useRef, useState } from "react";
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
import MenuPanel from "./admin/MenuPanel.js";
import CouponsPanel from "./admin/CouponsPanel.js";
import CounterSalesList from "./front/CounterSalesList.js";

type Tab =
  | "tables"
  | "menu"
  | "coupons"
  | "counter-sales"
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
            "coupons",
            "counter-sales",
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
            {t === "coupons" && "쿠폰"}
            {t === "counter-sales" && "현장 거래"}
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
      {tab === "coupons" && <CouponsPanel />}
      {tab === "counter-sales" && <CounterSalesList role={me.role} mfaEnabled={me.mfaEnabled} />}
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
  name: string | null;
  sortOrder: number;
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
  const [renaming, setRenaming] = useState<string | null>(null);
  const nameDraft = useRef("");
  const sortDraft = useRef("0");
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

  /** 표시 이름과 정렬 순서 저장. 테이블 번호는 손님 QR/이력과 묶여 있으므로 여기서 바꾸지 않는다. */
  const saveTableInfo = (t: AdminTable) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/tables/${t.id}`, {
        name: nameDraft.current.trim(),
        sortOrder: Number(sortDraft.current) || 0,
      });
      setRenaming(null);
      await refresh();
    })();

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
            <strong>
              {t.number}번{t.name ? ` · ${t.name}` : ""}
            </strong>{" "}
            <span className="badge">{t.status}</span>{" "}
            {t.ordersLocked && <span className="badge badge--warn">주문 잠금</span>}{" "}
            {t.paymentsLocked && <span className="badge badge--warn">결제 잠금</span>}
            <div className="text-muted">주문 URL: /t/{t.publicSlug}</div>
            {renaming === t.id && (
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <input
                  className="field"
                  style={{ marginBottom: 0, maxWidth: 180 }}
                  placeholder="표시 이름(선택)"
                  defaultValue={t.name ?? ""}
                  onChange={(e) => (nameDraft.current = e.target.value)}
                  aria-label="테이블 표시 이름"
                />
                <input
                  className="field"
                  style={{ marginBottom: 0, width: 100 }}
                  type="number"
                  defaultValue={t.sortOrder}
                  onChange={(e) => (sortDraft.current = e.target.value)}
                  aria-label="테이블 정렬 순서"
                />
                <button
                  className="btn-primary"
                  style={{ width: "auto", padding: "0 16px" }}
                  onClick={() => saveTableInfo(t)}
                >
                  저장
                </button>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-secondary" onClick={() => toggleOrdersLocked(t)}>
              {t.ordersLocked ? "주문 잠금 해제" : "주문 잠금"}
            </button>
            <button className="btn-secondary" onClick={() => togglePaymentsLocked(t)}>
              {t.paymentsLocked ? "결제 잠금 해제" : "결제 잠금"}
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                nameDraft.current = t.name ?? "";
                sortDraft.current = String(t.sortOrder);
                setRenaming(renaming === t.id ? null : t.id);
              }}
            >
              {renaming === t.id ? "편집 닫기" : "이름/순서"}
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

interface GamePlan {
  id: string;
  name: string;
  minutes: number;
  price: number;
  isActive: boolean;
}

/**
 * 보드게임 시간제 이용권(기존 기능). 새 게임 판매는 일반 메뉴로 하지만,
 * 진행 중인 자리와 과거 이력이 있으므로 여기서 계속 관리할 수 있어야 한다 —
 * 값을 고치거나 더 이상 팔지 않도록 숨기는 일을 DB를 직접 건드리지 않고 화면에서 끝낸다.
 * 이용권 행은 과거 사용 이력(TableGameUsage)이 참조하므로 삭제하지 않고 '판매 중지'로만 내린다.
 */
function GamePlansPanel() {
  const [plans, setPlans] = useState<GamePlan[]>([]);
  const [form, setForm] = useState({ name: "", minutes: "", price: "" });
  const [editing, setEditing] = useState<Record<string, { name: string; minutes: string; price: string }>>({});
  const { error, setError, wrap } = useErrorBanner();

  const refresh = () => api.get("/api/staff/admin/game-plans").then((d) => setPlans(d.plans));
  useEffect(() => {
    refresh().catch(() => setError("이용권 목록을 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = wrap(async () => {
    if (!form.name.trim() || !form.minutes || form.price === "") return;
    await api.post("/api/staff/admin/game-plans", {
      name: form.name.trim(),
      minutes: Number(form.minutes),
      price: Number(form.price),
    });
    setForm({ name: "", minutes: "", price: "" });
    await refresh();
  });

  const patch = (id: string, data: Record<string, unknown>) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/game-plans/${id}`, data);
      setEditing((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await refresh();
    })();

  return (
    <section>
      <h2>이용권 추가</h2>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        시간제 이용권은 테이블에 시간을 붙여 파는 기존 방식입니다. 보드게임 판수(1판/2판/3판)처럼 횟수로 파는 상품은
        <strong> 메뉴 탭에서 FRONT 전용 일반 메뉴</strong>로 등록해 현장 결제로 판매하세요. 한 자리에서 두 방식을
        같이 쓰면 같은 이용이 두 번 청구될 수 있으니 하나만 쓰는 걸 권합니다.
      </p>
      <input className="field" placeholder="이름(예: 20분)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input
        className="field"
        placeholder="분"
        type="number"
        min={1}
        value={form.minutes}
        onChange={(e) => setForm({ ...form, minutes: e.target.value })}
      />
      <input
        className="field"
        placeholder="가격(원)"
        type="number"
        min={0}
        value={form.price}
        onChange={(e) => setForm({ ...form, price: e.target.value })}
      />
      <button className="btn-primary" onClick={create}>
        추가
      </button>
      {error && <p className="error-text">{error}</p>}

      {plans.length === 0 && <p className="text-muted">등록된 이용권이 없어요.</p>}
      {plans.map((p) => {
        const draft = editing[p.id];
        return (
          <div key={p.id} className={`list-row ${p.isActive ? "" : "list-row--disabled"}`} style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div>
                <strong>{p.name}</strong> · {p.minutes}분 · {p.price.toLocaleString()}원{" "}
                {!p.isActive && <span className="badge badge--warn">판매 중지</span>}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    setEditing((prev) =>
                      draft
                        ? (() => {
                            const next = { ...prev };
                            delete next[p.id];
                            return next;
                          })()
                        : { ...prev, [p.id]: { name: p.name, minutes: String(p.minutes), price: String(p.price) } },
                    )
                  }
                >
                  {draft ? "닫기" : "편집"}
                </button>
                <button className={p.isActive ? "btn-danger-outline" : "btn-secondary"} onClick={() => patch(p.id, { isActive: !p.isActive })}>
                  {p.isActive ? "판매 중지" : "판매 재개"}
                </button>
              </div>
            </div>

            {draft && (
              <div className="admin-menu-editor">
                <div className="field-label-group">
                  <label className="field-label" htmlFor={`plan-name-${p.id}`}>
                    이름
                  </label>
                  <input
                    id={`plan-name-${p.id}`}
                    className="field"
                    value={draft.name}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [p.id]: { ...draft, name: e.target.value } }))}
                  />
                </div>
                <div className="field-label-group">
                  <label className="field-label" htmlFor={`plan-min-${p.id}`}>
                    분
                  </label>
                  <input
                    id={`plan-min-${p.id}`}
                    className="field"
                    type="number"
                    min={1}
                    value={draft.minutes}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [p.id]: { ...draft, minutes: e.target.value } }))}
                  />
                </div>
                <div className="field-label-group">
                  <label className="field-label" htmlFor={`plan-price-${p.id}`}>
                    가격(원)
                  </label>
                  <input
                    id={`plan-price-${p.id}`}
                    className="field"
                    type="number"
                    min={0}
                    value={draft.price}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [p.id]: { ...draft, price: e.target.value } }))}
                  />
                </div>
                <p className="text-muted" style={{ fontSize: "0.85rem" }}>
                  값을 고쳐도 <strong>이미 사용 중인 자리와 과거 이력은 그대로</strong>입니다(사용 시점의 분/가격이 따로 기록돼 있어요).
                  새로 붙이는 이용권부터 바뀐 값이 적용됩니다.
                </p>
                <button
                  className="btn-primary"
                  onClick={() =>
                    patch(p.id, { name: draft.name, minutes: Number(draft.minutes), price: Number(draft.price) })
                  }
                >
                  저장
                </button>
              </div>
            )}
          </div>
        );
      })}
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
