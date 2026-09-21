import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, errorMessage } from "../../lib/api.js";
import { useStaffMe } from "../../lib/useStaffMe.js";
import ConnectionBanner from "../../components/ConnectionBanner.js";
import OptionSheet from "../customer/OptionSheet.js";
import PaymentMethodPicker from "./PaymentMethodPicker.js";
import CashQuickAmount from "./CashQuickAmount.js";
import CounterSaleReceipt from "./CounterSaleReceipt.js";
import { formatWon } from "./format.js";
import type { PaymentMethod } from "./types.js";
import {
  counterLineKey,
  type CounterCartLine,
  type CounterMenuCategory,
  type CounterMenuItem,
  type CounterQuote,
  type CounterSaleDetail,
  type CouponLookup,
} from "./counterTypes.js";

/**
 * FRONT 현장 결제(요구사항.md §5).
 *
 * 테이블을 열지 않고 카운터에서 바로 수납을 기록한다. 금액은 **항상 서버 견적**을 표시하며
 * 이 화면이 계산한 값으로 결제하지 않는다. 확정은 멱등 키와 견적 해시를 함께 보내므로,
 * 응답을 놓치고 다시 눌러도 돈을 두 번 받지 않는다.
 */
export default function CounterSalePage() {
  const { me } = useStaffMe("FRONT");

  const [categories, setCategories] = useState<CounterMenuCategory[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [cart, setCart] = useState<CounterCartLine[]>([]);
  const [sheet, setSheet] = useState<{ item: CounterMenuItem; editKey?: string } | null>(null);

  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<CouponLookup | null>(null);
  const [couponTargetIndex, setCouponTargetIndex] = useState<number | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);

  const [quote, setQuote] = useState<CounterQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [methodCode, setMethodCode] = useState<string | null>(null);
  const [tendered, setTendered] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [recoverHint, setRecoverHint] = useState<string | null>(null);
  const [done, setDone] = useState<CounterSaleDetail | null>(null);

  /**
   * 확정 요청의 멱등 키. 실패해도 **같은 키를 그대로 유지**해 재시도가 중복 결제가 되지 않게 한다.
   * 장바구니/쿠폰/결제수단이 바뀌면 내용이 달라지므로 새 키를 발급한다(같은 키+다른 본문은 서버가 409).
   */
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());
  const resetIdempotencyKey = () => {
    idempotencyKeyRef.current = crypto.randomUUID();
  };

  const loadMenu = useCallback(async () => {
    const data = await api.get("/api/staff/front/counter/menu");
    setCategories(data.categories);
    setActiveCategoryId((prev) => prev ?? data.categories[0]?.id ?? null);
  }, []);

  useEffect(() => {
    if (!me) return;
    Promise.all([loadMenu(), api.get("/api/staff/front/payment-methods").then((d) => setMethods(d.methods))]).catch(
      (err) => setActionError(errorMessage(err, "현장 결제 정보를 불러오지 못했어요.")),
    );
  }, [me, loadMenu]);

  // ---- 장바구니 ----

  /**
   * 장바구니에 담기 / 옵션 변경. 같은 메뉴라도 옵션 조합이 다르면 별도 행이고,
   * 같은 조합이면 한 행으로 합친다(요구사항.md §3.2 — 서로 다른 옵션을 하나로 뭉개지 않는다).
   */
  function addToCart(item: CounterMenuItem, optionChoiceIds: string[], quantity: number, replaceKey?: string) {
    const key = counterLineKey(item.id, optionChoiceIds);
    setCart((prev) => {
      if (replaceKey) {
        // 편집한 행은 원래 자리에 그대로 둔다. 바꾼 조합이 이미 있던 행과 같아지면 하나로 합쳐진다.
        const at = Math.max(
          prev.findIndex((l) => l.key === replaceKey),
          0,
        );
        const next = prev.filter((l) => l.key !== replaceKey && l.key !== key);
        next.splice(at, 0, { key, item, quantity, optionChoiceIds });
        return next;
      }
      if (prev.some((l) => l.key === key)) {
        return prev.map((l) => (l.key === key ? { ...l, quantity: Math.min(50, l.quantity + quantity) } : l));
      }
      return [...prev, { key, item, quantity, optionChoiceIds }];
    });
    resetIdempotencyKey();
  }

  function openItem(item: CounterMenuItem) {
    if (item.blockedRequiredGroups.length > 0 || item.isSoldOut) return;
    if (item.optionGroups.length === 0) {
      addToCart(item, [], 1);
      return;
    }
    setSheet({ item });
  }

  const changeQuantity = (key: string, quantity: number) => {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, quantity: Math.max(1, Math.min(50, quantity)) } : l)));
    resetIdempotencyKey();
  };

  const removeLine = (key: string) => {
    setCart((prev) => prev.filter((l) => l.key !== key));
    resetIdempotencyKey();
  };

  const clearAll = () => {
    setCart([]);
    setCoupon(null);
    setCouponInput("");
    setCouponTargetIndex(null);
    setQuote(null);
    setMethodCode(null);
    setTendered(0);
    setActionError(null);
    setRecoverHint(null);
    resetIdempotencyKey();
  };

  // ---- 쿠폰 ----

  /** 번호 조회는 상태를 바꾸지 않는다. 실제 소진은 결제 확정과 동시에 서버에서만 일어난다. */
  async function checkCoupon() {
    if (!couponInput.trim()) return;
    setCouponChecking(true);
    setCouponError(null);
    try {
      const data = await api.get(`/api/staff/front/counter/coupons/${encodeURIComponent(couponInput.trim())}`);
      const found: CouponLookup = data.coupon;
      if (found.state !== "AVAILABLE") {
        setCoupon(null);
        setCouponError(`사용할 수 없는 쿠폰이에요 — ${found.stateLabel}.`);
        return;
      }
      if (found.targetsUnavailable) {
        setCoupon(null);
        setCouponError("이 상품권의 대상 메뉴가 모두 판매 중지되었어요. 관리자에게 문의해 주세요.");
        return;
      }
      setCoupon(found);
      setCouponInput(found.code);
      setCouponTargetIndex(null);
      resetIdempotencyKey();
    } catch (err) {
      setCoupon(null);
      setCouponError(errorMessage(err, "쿠폰을 확인하지 못했어요."));
    } finally {
      setCouponChecking(false);
    }
  }

  function removeCoupon() {
    setCoupon(null);
    setCouponInput("");
    setCouponTargetIndex(null);
    setCouponError(null);
    resetIdempotencyKey();
  }

  /** 상품권을 적용할 수 있는 장바구니 행(대상 메뉴가 담겨 있는 행). */
  const couponCandidates = useMemo(() => {
    if (!coupon || coupon.benefit.type !== "ITEM") return [];
    const allowed = new Set(coupon.benefit.targets.map((t) => t.menuItemId));
    return cart.map((line, index) => ({ line, index })).filter(({ line }) => allowed.has(line.item.id));
  }, [coupon, cart]);

  // ---- 견적 ----

  const cartPayload = useMemo(
    () => ({
      items: cart.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity, optionChoiceIds: l.optionChoiceIds })),
      couponCode: coupon?.code ?? null,
      couponTargetLineIndex: couponTargetIndex,
    }),
    [cart, coupon, couponTargetIndex],
  );

  useEffect(() => {
    if (cart.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    api
      .post("/api/staff/front/counter/quote", cartPayload)
      .then((data) => {
        if (cancelled) return;
        setQuote(data.quote);
        setQuoteError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(errorMessage(err, "금액을 계산하지 못했어요."));
      });
    return () => {
      cancelled = true;
    };
  }, [cartPayload, cart.length]);

  const selectedMethod = methods.find((m) => m.code === methodCode) ?? null;
  const total = quote?.totalAmount ?? 0;
  const isFree = quote !== null && total === 0;
  const canSubmit =
    !submitting &&
    quote !== null &&
    quoteError === null &&
    (isFree || (selectedMethod !== null && (!selectedMethod.isCash || tendered >= total)));

  // ---- 확정 ----

  async function confirm() {
    if (!quote || submitting) return;
    setSubmitting(true);
    setActionError(null);
    setRecoverHint(null);
    try {
      const data = await api.post("/api/staff/front/counter/confirm", {
        ...cartPayload,
        idempotencyKey: idempotencyKeyRef.current,
        methodCode: isFree ? null : methodCode,
        tenderedAmount: !isFree && selectedMethod?.isCash ? tendered : null,
        expectedQuoteHash: quote.quoteHash,
      });
      setDone(data.sale);
      // 성공이 확인된 뒤에만 장바구니를 비운다.
      setCart([]);
      setCoupon(null);
      setCouponInput("");
      setCouponTargetIndex(null);
      setQuote(null);
      setMethodCode(null);
      setTendered(0);
      resetIdempotencyKey();
    } catch (err) {
      if (err instanceof ApiError && err.code === "QUOTE_STALE") {
        setQuote((err.body?.quote as CounterQuote) ?? null);
        setActionError("메뉴 가격이나 쿠폰 상태가 바뀌었어요. 새 금액을 손님에게 확인한 뒤 다시 결제해 주세요.");
        return;
      }
      if (err instanceof ApiError && err.code === "IDEMPOTENCY_CONFLICT") {
        setActionError(err.message);
        setRecoverHint("같은 요청 번호로 이미 다른 내용이 처리됐어요. 아래 '이전 결제 확인'으로 결과를 먼저 확인해 주세요.");
        return;
      }
      setActionError(errorMessage(err, "결제를 확정하지 못했어요."));
      // 외부 단말/현금으로 이미 받은 돈은 서버 롤백으로 되돌아오지 않는다.
      setRecoverHint(
        "이미 돈을 받으셨다면 추가로 받지 마세요. 아래 '이전 결제 확인'으로 이 요청이 실제로 저장됐는지 먼저 확인한 뒤, 같은 화면에서 다시 시도해 주세요.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** 응답을 놓쳤을 때 같은 멱등 키로 서버에 결과를 되묻는다(이중 수납 방지). */
  async function recoverPrevious() {
    try {
      const data = await api.get(`/api/staff/front/counter/by-key/${encodeURIComponent(idempotencyKeyRef.current)}`);
      if (data.sale) {
        setDone(data.sale);
        setCart([]);
        setQuote(null);
        setRecoverHint(null);
        setActionError(null);
        resetIdempotencyKey();
      } else {
        setRecoverHint("이 요청은 아직 저장되지 않았어요. 그대로 다시 결제해도 중복되지 않습니다.");
      }
    } catch (err) {
      setActionError(errorMessage(err, "이전 결제를 확인하지 못했어요."));
    }
  }

  if (!me) return null;

  if (done) {
    return (
      <div className="page page--wide">
        <ConnectionBanner />
        <CounterSaleReceipt
          sale={done}
          onNewSale={() => {
            setDone(null);
            clearAll();
          }}
        />
      </div>
    );
  }

  const visibleItems = (categories.find((c) => c.id === activeCategoryId)?.items ?? []).filter((item) =>
    search.trim() ? item.name.toLowerCase().includes(search.trim().toLowerCase()) : true,
  );
  const searchAll = search.trim()
    ? categories.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(search.trim().toLowerCase()))
    : null;
  const shownItems = searchAll ?? visibleItems;

  return (
    <div className="page page--wide">
      <ConnectionBanner />
      <div className="checkout-header">
        <div>
          <Link to="/front" className="text-muted">
            ← FRONT 홈
          </Link>
          <h1>현장 결제</h1>
        </div>
        <span className="badge">테이블 없이 바로 수납</span>
      </div>

      <div className="counter-layout">
        {/* ---------------- 메뉴 ---------------- */}
        <section className="counter-menu">
          <input
            className="field"
            placeholder="메뉴 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="메뉴 검색"
          />
          {!searchAll && (
            <div className="seg-tabs" role="tablist">
              {categories.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  className="seg-tab"
                  aria-current={activeCategoryId === c.id}
                  onClick={() => setActiveCategoryId(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {categories.length === 0 && (
            <p className="text-muted">
              현장에서 팔 수 있는 메뉴가 없어요. 관리자 화면 &gt; 메뉴에서 판매 채널을 'FRONT 전용' 또는 '공통'으로
              설정해 주세요.
            </p>
          )}
          <div className="counter-menu-grid">
            {shownItems.map((item) => {
              const blocked = item.blockedRequiredGroups.length > 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="counter-menu-card"
                  disabled={item.isSoldOut || blocked}
                  onClick={() => openItem(item)}
                >
                  <span className="counter-menu-card__name">{item.name}</span>
                  <span className="counter-menu-card__price">{formatWon(item.price)}</span>
                  <span className="counter-menu-card__tags">
                    {item.needsCooking || item.showInKitchen ? (
                      <span className="badge">주방</span>
                    ) : (
                      <span className="badge">현장 제공</span>
                    )}
                    {item.optionGroups.length > 0 && <span className="badge">옵션</span>}
                    {item.isSoldOut && <span className="badge badge--danger">품절</span>}
                    {blocked && <span className="badge badge--danger">옵션 설정 필요</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ---------------- 장바구니 / 결제 ---------------- */}
        <section className="counter-cart">
          <h2 className="checkout-section-title">장바구니</h2>
          {cart.length === 0 && <p className="text-muted">메뉴를 눌러 담아 주세요.</p>}
          {cart.map((line, lineIndex) => {
            // 견적의 lines는 서버로 보낸 items와 같은 순서다 — 순번으로 짝짓는다.
            const quoteLine = quote?.lines[lineIndex];
            const optionNames = line.optionChoiceIds
              .map((id) => line.item.optionGroups.flatMap((g) => g.choices).find((c) => c.id === id))
              .filter(Boolean)
              .map((c) => `${c!.name}${c!.extraPrice > 0 ? ` +${c!.extraPrice.toLocaleString()}원` : " +0원"}`);
            return (
              <div className="cart-line" key={line.key}>
                <div className="cart-line__top">
                  <div>
                    <div className="cart-line__name">{line.item.name}</div>
                    {optionNames.length > 0 && <div className="cart-line__options">{optionNames.join(" · ")}</div>}
                  </div>
                  <div className="cart-line__price">{formatWon(quoteLine?.lineTotal ?? line.item.price * line.quantity)}</div>
                </div>
                <div className="cart-line__bottom">
                  <div className="qty-stepper">
                    <button
                      type="button"
                      className="qty-btn"
                      disabled={line.quantity <= 1}
                      onClick={() => changeQuantity(line.key, line.quantity - 1)}
                      aria-label="수량 줄이기"
                    >
                      −
                    </button>
                    <span className="qty-value">{line.quantity}</span>
                    <button
                      type="button"
                      className="qty-btn"
                      disabled={line.quantity >= 50}
                      onClick={() => changeQuantity(line.key, line.quantity + 1)}
                      aria-label="수량 늘리기"
                    >
                      +
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {line.item.optionGroups.length > 0 && (
                      <button
                        type="button"
                        className="cart-line__remove"
                        onClick={() => setSheet({ item: line.item, editKey: line.key })}
                      >
                        옵션 변경
                      </button>
                    )}
                    <button type="button" className="cart-line__remove" onClick={() => removeLine(line.key)}>
                      삭제
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {/* ---- 쿠폰 ---- */}
          <h2 className="checkout-section-title">쿠폰 사용</h2>
          {!coupon && (
            <>
              <div className="counter-coupon-row">
                <input
                  className="field"
                  style={{ marginBottom: 0 }}
                  placeholder="쿠폰 번호 (예: 1 / 01 / 001)"
                  inputMode="numeric"
                  maxLength={3}
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.replace(/[^0-9]/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && checkCoupon()}
                  aria-label="쿠폰 번호"
                />
                <button className="btn-secondary" onClick={checkCoupon} disabled={couponChecking || !couponInput.trim()}>
                  {couponChecking ? "확인 중" : "혜택 확인"}
                </button>
              </div>
              {couponError && <p className="error-text">{couponError}</p>}
              <p className="text-muted" style={{ fontSize: "0.85rem" }}>
                거래당 1장만 사용할 수 있어요. 확인만으로는 사용되지 않고, 결제를 확정할 때 사용 완료 처리됩니다.
              </p>
            </>
          )}
          {coupon && (
            <div className="counter-coupon-applied">
              <div>
                <strong>{coupon.code}번</strong> · {coupon.benefitLabel}
                {coupon.expiresAt && (
                  <div className="text-muted">
                    만료: {new Date(coupon.expiresAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                  </div>
                )}
                {coupon.benefit.type === "AMOUNT" && (
                  <div className="text-muted">남는 금액은 돌려드리지 않아요(잔액 소멸).</div>
                )}
                {coupon.benefit.type === "ITEM" && (
                  <div className="text-muted">대상 메뉴 1개의 기본 가격만 무료예요. 유료 옵션은 따로 결제합니다.</div>
                )}
              </div>
              <button className="btn-secondary" onClick={removeCoupon}>
                쿠폰 빼기
              </button>
            </div>
          )}
          {coupon?.benefit.type === "ITEM" && couponCandidates.length > 0 && (
            <div className="counter-coupon-targets">
              <div className="checkout-field-label">무료로 제공할 메뉴 1개</div>
              {couponCandidates.map(({ line, index }) => (
                <label className="option-choice" key={line.key}>
                  <input
                    type="radio"
                    name="coupon-target"
                    checked={(couponTargetIndex ?? couponCandidates[0].index) === index}
                    onChange={() => {
                      setCouponTargetIndex(index);
                      resetIdempotencyKey();
                    }}
                  />
                  <span className="option-choice__name">{line.item.name}</span>
                  <span className="option-choice__price">기본가 {formatWon(line.item.price)}</span>
                </label>
              ))}
            </div>
          )}
          {coupon?.benefit.type === "ITEM" && couponCandidates.length === 0 && cart.length > 0 && (
            <p className="error-text">
              장바구니에 이 상품권의 대상 메뉴({coupon.benefit.targets.map((t) => t.nameSnapshot).join(" 또는 ")})가 없어요.
            </p>
          )}

          {/* ---- 금액 ---- */}
          <div className="bill-card">
            <div className="bill-card__row">
              <span>기본 금액</span>
              <span>{formatWon(quote?.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) ?? 0)}</span>
            </div>
            <div className="bill-card__row">
              <span>옵션 금액</span>
              <span>
                {formatWon(
                  (quote?.subtotal ?? 0) - (quote?.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) ?? 0),
                )}
              </span>
            </div>
            <div className="bill-card__row">
              <span>쿠폰 할인</span>
              <span>-{formatWon(quote?.discountAmount ?? 0)}</span>
            </div>
            <div className="bill-card__row bill-card__row--total">
              <span>받을 금액</span>
              <span>{formatWon(total)}</span>
            </div>
          </div>
          {quoteError && <p className="error-text">{quoteError}</p>}

          {/* ---- 결제 ---- */}
          {quote && !isFree && (
            <>
              <h2 className="checkout-section-title">수납</h2>
              <PaymentMethodPicker
                methods={methods}
                selectedCode={methodCode}
                onSelect={(code) => {
                  setMethodCode(code);
                  resetIdempotencyKey();
                }}
              />
              {selectedMethod?.isCash && (
                <CashQuickAmount
                  targetAmount={total}
                  tendered={tendered}
                  onChange={(v) => {
                    setTendered(v);
                    resetIdempotencyKey();
                  }}
                />
              )}
            </>
          )}
          {isFree && (
            <p className="checkout-notice">
              쿠폰으로 전액 할인되어 받을 금액이 없어요. 아래 버튼을 누르면 <strong>무료 제공 완료</strong>로 기록됩니다.
            </p>
          )}

          {quote?.hasCounterItems && (
            <p className="text-muted" style={{ fontSize: "0.85rem" }}>
              결제 확인 버튼을 누르면 현장 제공 상품(룰렛/보드게임/음료 등)은 <strong>판매·제공이 함께 확정</strong>됩니다.
              {quote.hasKitchenItems && " 주방 조리 상품은 결제 후 주방으로 전달돼요."}
            </p>
          )}

          {actionError && <p className="error-text">{actionError}</p>}
          {recoverHint && (
            <div className="checkout-refund-banner" style={{ textAlign: "left" }}>
              {recoverHint}
              <button className="btn-secondary" style={{ marginTop: 8 }} onClick={recoverPrevious}>
                이전 결제 확인
              </button>
            </div>
          )}

          <button className="btn-primary checkout-submit-btn" disabled={!canSubmit} onClick={confirm}>
            {submitting
              ? "결제를 기록하는 중이에요..."
              : isFree
                ? "무료 제공 완료로 확정"
                : `${formatWon(total)} 수납 확인`}
          </button>
          {cart.length > 0 && (
            <button className="btn-secondary" style={{ marginTop: 8 }} onClick={clearAll} disabled={submitting}>
              장바구니 비우기
            </button>
          )}
        </section>
      </div>

      {sheet && (
        <OptionSheet
          item={sheet.item}
          confirmLabelPrefix={sheet.editKey ? "변경" : "담기"}
          initialOptionChoiceIds={sheet.editKey ? cart.find((l) => l.key === sheet.editKey)?.optionChoiceIds : undefined}
          initialQuantity={sheet.editKey ? cart.find((l) => l.key === sheet.editKey)?.quantity : undefined}
          onClose={() => setSheet(null)}
          onConfirm={({ optionChoiceIds, quantity }) => {
            addToCart(sheet.item, optionChoiceIds, quantity, sheet.editKey);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}
