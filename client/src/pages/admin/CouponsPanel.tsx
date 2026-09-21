import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.js";
import DangerConfirmModal from "../../components/DangerConfirmModal.js";
import { useErrorBanner } from "./shared.js";

type CouponState = "AVAILABLE" | "USED" | "EXPIRED" | "CANCELLED";

interface CouponRow {
  id: string;
  code: string;
  state: CouponState;
  stateLabel: string;
  type: "AMOUNT" | "ITEM";
  benefitLabel: string;
  batchId: string;
  batchName: string;
  issuedAt: string;
  issuedBy: string;
  expiresAt: string | null;
  redemption: {
    /** 사용처는 FRONT 현장 거래 또는 테이블 후불 정산 중 하나다. */
    usedAt:
      | { kind: "COUNTER"; saleNo: number; status: string }
      | { kind: "TABLE"; tableNumber: number | null; status: string | null };
    discountAmount: number;
    redeemedAt: string;
    redeemedBy: string;
    cancelledAt: string | null;
  } | null;
}

interface BatchRow {
  id: string;
  type: "AMOUNT" | "ITEM";
  name: string;
  memo: string | null;
  benefitLabel: string;
  issuedCount: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  counts: Record<CouponState, number>;
}

interface MenuOption {
  id: string;
  name: string;
  price: number;
}

const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });

/**
 * 쿠폰 발급/관리(요구사항.md §6.1).
 *
 * 번호는 시스템 전체에서 001~999로 한 번씩만 쓰이고 재사용되지 않는다. 발급은 원자적이라
 * "절반만 발급"이 없고, 같은 발급 요청을 다시 눌러도 중복 발급되지 않는다.
 */
export default function CouponsPanel() {
  const [availability, setAvailability] = useState<{ issued: number; remaining: number; max: number } | null>(null);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [menuItems, setMenuItems] = useState<MenuOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [issued, setIssued] = useState<{ codes: string[]; benefitLabel: string; expiresAt: string | null } | null>(null);
  const [cancelBatch, setCancelBatch] = useState<BatchRow | null>(null);
  const { error, setError, wrap } = useErrorBanner();

  const [form, setForm] = useState({
    type: "AMOUNT" as "AMOUNT" | "ITEM",
    name: "",
    memo: "",
    amount: "",
    quantity: "10",
    expiresAt: "",
    targetMenuItemIds: [] as string[],
  });
  const [filter, setFilter] = useState<{ code: string; state: "" | CouponState; type: "" | "AMOUNT" | "ITEM"; batchId: string }>({
    code: "",
    state: "",
    type: "",
    batchId: "",
  });
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filter.code) params.set("code", filter.code);
    if (filter.state) params.set("state", filter.state);
    if (filter.type) params.set("type", filter.type);
    if (filter.batchId) params.set("batchId", filter.batchId);
    return params.toString();
  }, [filter]);

  const refresh = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      api.get("/api/staff/admin/coupons/availability"),
      api.get("/api/staff/admin/coupons/batches"),
      api.get(`/api/staff/admin/coupons?${query}`),
    ]);
    setAvailability(a.availability);
    setBatches(b.batches);
    setCoupons(c.coupons);
    setSelected(new Set());
  }, [query]);

  useEffect(() => {
    refresh().catch((err) => setError(errorMessage(err, "쿠폰 정보를 불러오지 못했어요.")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    api
      .get("/api/staff/admin/menu/categories")
      .then((d) =>
        setMenuItems(
          (d.categories as { items: MenuOption[] }[]).flatMap((c) =>
            c.items.map((i) => ({ id: i.id, name: i.name, price: i.price })),
          ),
        ),
      )
      .catch(() => undefined);
  }, []);

  const issue = wrap(async () => {
    const quantity = Number(form.quantity);
    if (!form.name.trim() || !quantity) {
      setError("쿠폰 이름과 발급 수량을 입력해 주세요.");
      return;
    }
    const result = await api.post("/api/staff/admin/coupons/batches", {
      idempotencyKey: idempotencyKeyRef.current,
      type: form.type,
      name: form.name.trim(),
      memo: form.memo || undefined,
      amount: form.type === "AMOUNT" ? Number(form.amount) : undefined,
      targetMenuItemIds: form.type === "ITEM" ? form.targetMenuItemIds : undefined,
      quantity,
      expiresAt: form.expiresAt || null,
    });
    setIssued({
      codes: result.batch.codes,
      benefitLabel:
        form.type === "AMOUNT"
          ? `${Number(form.amount).toLocaleString()}원 할인`
          : `${form.targetMenuItemIds.map((id) => menuItems.find((m) => m.id === id)?.name ?? id).join(" 또는 ")} 중 1개 무료`,
      expiresAt: result.batch.expiresAt,
    });
    // 다음 발급은 새 요청이다 — 같은 키를 재사용하면 서버가 이전 배치를 그대로 돌려준다.
    idempotencyKeyRef.current = crypto.randomUUID();
    setForm({ ...form, name: "", memo: "" });
    await refresh();
  });

  const cancelSelected = wrap(async () => {
    if (selected.size === 0) return;
    const result = await api.post("/api/staff/admin/coupons/cancel", { couponIds: [...selected] });
    setError(
      result.result.skippedCount > 0
        ? `${result.result.cancelledCount}장을 취소했어요. 이미 사용/취소된 ${result.result.skippedCount}장은 건드리지 않았습니다.`
        : null,
    );
    await refresh();
  });

  /**
   * 한 배치의 미사용 쿠폰을 한 번에 발급 취소한다(요구사항.md §6.1 — 잘못 발급했으면 미사용분 취소 후 재발급).
   * 이미 사용된 쿠폰은 서버가 건너뛰므로 실수로 사용 이력이 지워지지 않는다.
   */
  const cancelWholeBatch = wrap(async () => {
    if (!cancelBatch) return;
    const target = cancelBatch;
    setCancelBatch(null);
    const list = await api.get(`/api/staff/admin/coupons?batchId=${target.id}&state=AVAILABLE&limit=1000`);
    const ids = (list.coupons as CouponRow[]).map((c) => c.id);
    if (ids.length === 0) return;
    const result = await api.post("/api/staff/admin/coupons/cancel", { couponIds: ids });
    setError(
      result.result.skippedCount > 0
        ? `${result.result.cancelledCount}장을 취소했어요. 이미 사용/취소된 ${result.result.skippedCount}장은 건드리지 않았습니다.`
        : null,
    );
    await refresh();
  });

  const preview = availability
    ? `${String(availability.issued + 1).padStart(3, "0")} 부터 ${Math.min(
        availability.issued + (Number(form.quantity) || 0),
        availability.max,
      )
        .toString()
        .padStart(3, "0")} 까지 (남은 번호 ${availability.remaining}장)`
    : "";

  return (
    <section>
      <h2>쿠폰 발급</h2>
      {availability && (
        <p className="text-muted">
          발급된 번호 {availability.issued} / {availability.max} · 남은 번호 <strong>{availability.remaining}장</strong>
          {availability.remaining === 0 && " — 더 이상 발급할 수 없어요. 번호는 재사용하지 않습니다."}
        </p>
      )}

      <select className="field" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as "AMOUNT" | "ITEM" })}>
        <option value="AMOUNT">금액권 (정해진 금액만큼 할인)</option>
        <option value="ITEM">상품권 (지정 메뉴 1개 무료)</option>
      </select>
      <input className="field" placeholder="쿠폰 이름 (예: 방문 감사 1,000원권)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input className="field" placeholder="메모(선택)" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />

      {form.type === "AMOUNT" ? (
        <input
          className="field"
          type="number"
          min={1}
          placeholder="권면 금액(원)"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />
      ) : (
        <div className="admin-option-group">
          <div className="checkout-field-label">무료로 제공할 대상 메뉴 (여러 개 지정하면 그중 1개)</div>
          {menuItems.length === 0 && <p className="text-muted">먼저 메뉴 탭에서 메뉴를 등록해 주세요.</p>}
          {menuItems.map((m) => (
            <label className="option-choice" key={m.id}>
              <input
                type="checkbox"
                checked={form.targetMenuItemIds.includes(m.id)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    targetMenuItemIds: e.target.checked
                      ? [...form.targetMenuItemIds, m.id]
                      : form.targetMenuItemIds.filter((id) => id !== m.id),
                  })
                }
              />
              <span className="option-choice__name">{m.name}</span>
              <span className="option-choice__price">{m.price.toLocaleString()}원</span>
            </label>
          ))}
        </div>
      )}

      <div className="field-label-group">
        <label className="field-label" htmlFor="coupon-quantity">
          발급 수량
        </label>
        <input
          id="coupon-quantity"
          className="field"
          type="number"
          min={1}
          max={availability?.remaining ?? 999}
          value={form.quantity}
          onChange={(e) => setForm({ ...form, quantity: e.target.value })}
        />
      </div>
      <div className="field-label-group">
        <label className="field-label" htmlFor="coupon-expires">
          만료일(선택) — 한국시간 그날 23:59까지
        </label>
        <input
          id="coupon-expires"
          className="field"
          type="date"
          value={form.expiresAt}
          onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
        />
      </div>

      <p className="text-muted">예상 번호 범위: {preview}</p>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        쿠폰은 거래당 1장만 쓸 수 있고 다른 할인과 중복되지 않습니다. 금액권은 남는 금액을 돌려주지 않고(잔액 소멸),
        상품권은 대상 메뉴 1개의 기본 가격만 무료이며 유료 옵션은 따로 결제합니다.
      </p>

      <button className="btn-primary" onClick={issue} disabled={(availability?.remaining ?? 0) === 0}>
        쿠폰 발급
      </button>
      {error && <p className="error-text">{error}</p>}

      {issued && (
        <div className="join-code-card" style={{ marginTop: 16 }}>
          <div className="table-hero__number">{issued.codes.length}장 발급 완료</div>
          <div className="text-muted">{issued.benefitLabel}</div>
          <div className="coupon-code-grid">
            {issued.codes.map((code) => (
              <span key={code} className="coupon-code-chip">
                {code}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 12 }}>
            <button className="btn-secondary" onClick={() => window.print()}>
              인쇄하기
            </button>
            <button className="btn-secondary" onClick={() => setIssued(null)}>
              닫기
            </button>
          </div>
          <p className="text-muted" style={{ fontSize: "0.85rem" }}>
            각 쿠폰에 번호 · 혜택 · 만료일 · "1회만 사용 가능"을 함께 적어 주세요.
            {issued.expiresAt && ` 만료: ${kst(issued.expiresAt)}`}
          </p>
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>발급 배치</h2>
      {batches.length === 0 && <p className="text-muted">발급 이력이 없어요.</p>}
      {batches.map((b) => (
        <div key={b.id} className="list-row">
          <div>
            <strong>{b.name}</strong> · {b.benefitLabel} · {b.issuedCount}장
            <div className="text-muted">
              {kst(b.createdAt)} · {b.createdBy}
              {b.expiresAt && ` · 만료 ${kst(b.expiresAt)}`}
              {b.memo && ` · ${b.memo}`}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <span className="badge">사용 가능 {b.counts.AVAILABLE}</span>
              <span className="badge">사용 완료 {b.counts.USED}</span>
              <span className="badge badge--warn">만료 {b.counts.EXPIRED}</span>
              <span className="badge badge--danger">발급 취소 {b.counts.CANCELLED}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-secondary" onClick={() => setFilter({ code: "", state: "", type: "", batchId: b.id })}>
              이 배치 보기
            </button>
            {b.counts.AVAILABLE > 0 && (
              <button className="btn-danger-outline" onClick={() => setCancelBatch(b)}>
                미사용 {b.counts.AVAILABLE}장 취소
              </button>
            )}
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: 32 }}>쿠폰 목록</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input
          className="field"
          style={{ marginBottom: 0, width: 140 }}
          placeholder="번호 검색"
          value={filter.code}
          onChange={(e) => setFilter({ ...filter, code: e.target.value.replace(/[^0-9]/g, "") })}
          aria-label="쿠폰 번호 검색"
        />
        <select
          className="field"
          style={{ marginBottom: 0, width: 160 }}
          value={filter.state}
          onChange={(e) => setFilter({ ...filter, state: e.target.value as "" | CouponState })}
          aria-label="상태 필터"
        >
          <option value="">전체 상태</option>
          <option value="AVAILABLE">사용 가능</option>
          <option value="USED">사용 완료</option>
          <option value="EXPIRED">유효기간 만료</option>
          <option value="CANCELLED">발급 취소</option>
        </select>
        <select
          className="field"
          style={{ marginBottom: 0, width: 140 }}
          value={filter.type}
          onChange={(e) => setFilter({ ...filter, type: e.target.value as "" | "AMOUNT" | "ITEM" })}
          aria-label="종류 필터"
        >
          <option value="">전체 종류</option>
          <option value="AMOUNT">금액권</option>
          <option value="ITEM">상품권</option>
        </select>
        {filter.batchId && (
          <button className="btn-secondary" onClick={() => setFilter({ ...filter, batchId: "" })}>
            배치 필터 해제
          </button>
        )}
        <a
          className="btn-secondary"
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
          href={`/api/staff/admin/export/coupons.csv?format=excel&${query}`}
        >
          CSV (엑셀용)
        </a>
        <a
          className="btn-secondary"
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
          href={`/api/staff/admin/export/coupons.csv?${query}`}
        >
          CSV (데이터용)
        </a>
        <button className="btn-danger-outline" onClick={cancelSelected} disabled={selected.size === 0}>
          선택한 {selected.size}장 발급 취소
        </button>
      </div>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        <strong>CSV (엑셀용)</strong>은 번호를 텍스트로 고정해 엑셀에서 바로 열어도 <strong>001이 그대로</strong>
        유지됩니다(저장 후 다시 열어도 유지). 다른 프로그램으로 읽어들일 때는 번호가 평문인{" "}
        <strong>CSV (데이터용)</strong>을 쓰세요. 두 파일 모두 "쿠폰 001" 표시용 열이 함께 들어 있고, 수식 주입
        방어도 그대로 적용됩니다. 사용 완료된 쿠폰은 취소할 수 없어요.
      </p>

      {coupons.length === 0 && <p className="text-muted">조건에 맞는 쿠폰이 없어요.</p>}
      {cancelBatch && (
        <DangerConfirmModal
          title={`${cancelBatch.name} — 미사용 ${cancelBatch.counts.AVAILABLE}장 발급 취소`}
          description="아직 쓰지 않은 쿠폰만 사용 불가로 바꿉니다. 이미 사용된 쿠폰은 건드리지 않고, 번호는 어느 경우에도 다시 발급되지 않습니다. 잘못 발급했다면 취소한 뒤 새 배치를 발급하세요."
          details={[
            { label: "혜택", value: cancelBatch.benefitLabel },
            { label: "사용 완료(유지)", value: `${cancelBatch.counts.USED}장` },
          ]}
          confirmLabel="미사용분 취소하기"
          onConfirm={cancelWholeBatch}
          onCancel={() => setCancelBatch(null)}
        />
      )}

      {coupons.map((c) => (
        <div key={c.id} className="list-row">
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={selected.has(c.id)}
              disabled={c.state !== "AVAILABLE"}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(c.id);
                else next.delete(c.id);
                setSelected(next);
              }}
              aria-label={`${c.code}번 선택`}
            />
            <div>
              <strong>{c.code}</strong> · {c.benefitLabel}{" "}
              <span className={`badge ${c.state === "AVAILABLE" ? "" : c.state === "USED" ? "badge--warn" : "badge--danger"}`}>
                {c.stateLabel}
              </span>
              <div className="text-muted">
                {c.batchName} · 발급 {kst(c.issuedAt)} ({c.issuedBy})
                {c.expiresAt && ` · 만료 ${kst(c.expiresAt)}`}
              </div>
              {c.redemption && (
                <div className="text-muted">
                  사용:{" "}
                  {c.redemption.usedAt.kind === "COUNTER"
                    ? `현장 거래 #${String(c.redemption.usedAt.saleNo).padStart(3, "0")}`
                    : `${c.redemption.usedAt.tableNumber ?? "?"}번 테이블 정산`}{" "}
                  · {c.redemption.discountAmount.toLocaleString()}원 · {kst(c.redemption.redeemedAt)} ·{" "}
                  {c.redemption.redeemedBy}
                  {c.redemption.cancelledAt && " · 취소로 제공 실적 취소됨(쿠폰은 사용 완료 유지)"}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
