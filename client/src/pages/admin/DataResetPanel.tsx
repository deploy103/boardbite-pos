import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner, useStepUpGuard } from "./shared.js";
import StepUpModal from "../../components/StepUpModal.js";

type Scope = "tables" | "counterSales" | "payments" | "revenue" | "coupons" | "inventory" | "menu";

interface Preview {
  counts: {
    tables: { tableSessions: number; tableOrders: number; tables: number };
    counterSales: { counterSales: number };
    payments: { payments: number };
    revenue: { closings: number };
    coupons: { couponBatches: number; coupons: number };
    inventory: { inventoryItems: number };
    menu: { menuCategories: number; menuItems: number };
  };
  dependsOn: Record<Scope, Scope[]>;
}

const CONFIRM_TEXT = "초기화";

const SCOPES: { key: Scope; label: string; desc: string; count: (c: Preview["counts"]) => string }[] = [
  {
    key: "tables",
    label: "테이블 이용 기록",
    desc: "테이블 세션·주문·결제·호출 기록을 지우고 열린 테이블을 비워요. 테이블 번호·이름·QR 주소는 그대로 남아요.",
    count: (c) => `이용 기록 ${c.tables.tableSessions}건 · 주문 ${c.tables.tableOrders}건 (테이블 ${c.tables.tables}개는 유지)`,
  },
  {
    key: "counterSales",
    label: "현장 거래 기록",
    desc: "FRONT 현장 결제 거래와 그 주문·결제를 지워요. 다음 주문번호는 1번부터 다시 시작해요.",
    count: (c) => `현장 거래 ${c.counterSales.counterSales}건`,
  },
  {
    key: "payments",
    label: "결제내역",
    desc: "모든 결제·할인·환불 기록을 지워요. 결제는 주문에 붙어 있으므로 테이블 이용 기록과 현장 거래 기록도 함께 지워져요.",
    count: (c) => `결제 기록 ${c.payments.payments}건`,
  },
  {
    key: "revenue",
    label: "매출현황 · 영업 마감",
    desc: "매출은 결제내역에서 계산되므로 결제내역과 영업 마감 기록을 함께 지워요.",
    count: (c) => `마감 기록 ${c.revenue.closings}건`,
  },
  {
    key: "coupons",
    label: "쿠폰",
    desc: "발급한 쿠폰 묶음·쿠폰 번호·사용 기록을 모두 지워요. 번호는 001부터 다시 발급할 수 있어요.",
    count: (c) => `묶음 ${c.coupons.couponBatches}개 · 쿠폰 ${c.coupons.coupons}장`,
  },
  {
    key: "inventory",
    label: "재고 물품",
    desc: "공용 재고 물품을 지워요. 메뉴와 옵션은 남고 물품 연결만 풀려요.",
    count: (c) => `재고 물품 ${c.inventory.inventoryItems}개`,
  },
  {
    key: "menu",
    label: "메뉴 (카테고리·메뉴·옵션)",
    desc: "메뉴를 전부 지워요. 주문이 메뉴를 참조하므로 테이블·현장 거래 기록과 쿠폰도 함께 지워져요. 메뉴를 다시 등록해야 하니 신중히 고르세요.",
    count: (c) => `카테고리 ${c.menu.menuCategories}개 · 메뉴 ${c.menu.menuItems}개`,
  },
];

const LABEL: Record<Scope, string> = Object.fromEntries(SCOPES.map((s) => [s.key, s.label])) as Record<Scope, string>;

const DELETED_LABEL: Record<string, string> = {
  tableSessions: "테이블 이용",
  tableOrders: "테이블 주문",
  tablePayments: "테이블 결제",
  counterSales: "현장 거래",
  counterOrders: "현장 주문",
  counterPayments: "현장 결제",
  restoredCoupons: "다시 사용 가능해진 쿠폰",
  closings: "영업 마감",
  couponBatches: "쿠폰 묶음",
  coupons: "쿠폰",
  inventoryItems: "재고 물품",
  menuItems: "메뉴",
  menuCategories: "카테고리",
};

function expand(selected: Set<Scope>, dependsOn: Record<Scope, Scope[]>): Set<Scope> {
  const out = new Set<Scope>();
  const visit = (s: Scope) => {
    if (out.has(s)) return;
    out.add(s);
    dependsOn[s].forEach(visit);
  };
  selected.forEach(visit);
  return out;
}

/**
 * 항목별 데이터 초기화. 축제 전 리허설 데이터를 지우되 메뉴·계정 설정은 남기기 위한 화면이다.
 * 서버가 지우기 직전에 백업을 자동으로 만들며, 실행에는 step-up 재인증과 확인 문구 입력이 필요하다.
 * 직원 계정·결제수단·운영 설정·이용권·감사 로그·백업은 어떤 항목을 골라도 지워지지 않는다.
 */
export default function DataResetPanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<Scope>>(new Set());
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<{ deleted: Record<string, number>; backup: string } | null>(null);
  const { error, setError, wrap } = useErrorBanner();
  const { pending, setPending, guard } = useStepUpGuard();

  const refresh = () => api.get("/api/staff/admin/data-reset/preview").then((d) => setPreview(d.preview));

  useEffect(() => {
    refresh().catch(() => setError("현재 데이터 현황을 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applied = useMemo(
    () => (preview ? expand(selected, preview.dependsOn) : new Set<Scope>()),
    [selected, preview],
  );

  const toggle = (s: Scope) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const run = wrap(async () => {
    await guard("데이터 초기화", async () => {
      setRunning(true);
      try {
        const d = await api.post("/api/staff/admin/data-reset", { scopes: [...selected], confirmText });
        setDone({ deleted: d.result.deleted, backup: d.result.backup });
        setSelected(new Set());
        setConfirmText("");
        await refresh();
      } finally {
        setRunning(false);
      }
    });
  });

  return (
    <section>
      <p className="text-muted">
        리허설·테스트로 쌓인 기록을 항목별로 지워요. 지우기 직전에 DB 백업을 자동으로 만들어 두니, 잘못 지웠다면
        백업 탭의 파일로 되돌릴 수 있어요. 직원 계정·결제수단·운영설정·이용권·감사 로그는 지워지지 않아요.
      </p>

      {preview &&
        SCOPES.map((s) => {
          const forced = applied.has(s.key) && !selected.has(s.key);
          return (
            <label key={s.key} className="list-row" style={{ cursor: "pointer", alignItems: "flex-start", gap: 12 }}>
              <input
                type="checkbox"
                checked={applied.has(s.key)}
                disabled={forced}
                onChange={() => toggle(s.key)}
                style={{ marginTop: 4 }}
              />
              <div style={{ flex: 1 }}>
                <strong>{s.label}</strong>
                {forced && <span className="text-muted"> (선택한 항목 때문에 함께 지워져요)</span>}
                <div className="text-muted">{s.desc}</div>
                <div className="text-muted" style={{ fontSize: "0.85rem" }}>
                  현재 {s.count(preview.counts)}
                </div>
              </div>
            </label>
          );
        })}

      {applied.size > 0 && (
        <div style={{ marginTop: 16 }}>
          <p>
            <strong style={{ color: "var(--color-danger)" }}>지워질 항목:</strong>{" "}
            {SCOPES.filter((s) => applied.has(s.key))
              .map((s) => LABEL[s.key])
              .join(", ")}
          </p>
          <input
            className="field"
            placeholder={`확인을 위해 '${CONFIRM_TEXT}'를 입력하세요`}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button
            className="btn-danger"
            style={{ width: 220, marginTop: 8 }}
            onClick={run}
            disabled={running || confirmText.trim() !== CONFIRM_TEXT}
          >
            {running ? "백업 후 지우는 중이에요..." : "선택 항목 초기화"}
          </button>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {done && (
        <div className="list-row" style={{ display: "block", marginTop: 16 }}>
          <strong>초기화했어요.</strong>
          <div className="text-muted">자동 백업: {done.backup}</div>
          <div className="text-muted">
            {Object.entries(done.deleted)
              .map(([k, v]) => `${DELETED_LABEL[k] ?? k} ${v}건`)
              .join(" · ") || "지운 기록이 없어요."}
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
            void retry().catch((err) => setError(err instanceof Error ? err.message : "초기화를 완료하지 못했어요."));
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
