import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { api, ApiError } from "../../lib/api.js";
import CartSheet from "./CartSheet.js";
import MenuSkeleton from "./MenuSkeleton.js";
import OptionSheet from "./OptionSheet.js";
import OrderStatusTimeline from "./OrderStatusTimeline.js";
import type { Bill, CartLine, MenuCategory, MenuItem, Order } from "./types.js";
import { cartLineKey, lineUnitPrice, REALTIME_EVENTS } from "./types.js";

type Phase = "loading" | "closed" | "error" | "open";

const ORDERS_POLL_INTERVAL_MS = 20000;

export default function CustomerApp() {
  const { slug } = useParams();
  const [phase, setPhase] = useState<Phase>("loading");
  const [closedMessage, setClosedMessage] = useState("");
  const [tableNumber, setTableNumber] = useState<number | null>(null);

  const [categories, setCategories] = useState<MenuCategory[] | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [optionSheetItem, setOptionSheetItem] = useState<MenuItem | null>(null);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  const [orders, setOrders] = useState<Order[]>([]);
  const [bill, setBill] = useState<Bill | null>(null);
  const [view, setView] = useState<"menu" | "orders">("menu");
  const [staffCallStatus, setStaffCallStatus] = useState<"idle" | "pending" | "acked">("idle");

  // 더블탭/네트워크 재시도로 같은 주문이 두 번 들어가지 않도록, 실패 시에는 같은 키를 재사용한다.
  const idempotencyKeyRef = useRef<string | null>(null);

  const loadMenu = useCallback(async () => {
    try {
      const data = await api.get("/api/customer/menu");
      setCategories(data.categories);
      setMenuError(null);
      setActiveCategoryId((prev) => prev ?? data.categories[0]?.id ?? null);
    } catch {
      setMenuError("메뉴를 불러오지 못했어요. 아래로 당겨서 새로고침해 주세요.");
    }
  }, []);

  const loadOrders = useCallback(async () => {
    const data = await api.get("/api/customer/orders");
    setOrders(data.orders);
  }, []);

  const loadBill = useCallback(async () => {
    const data = await api.get("/api/customer/session");
    setBill(data.bill);
  }, []);

  const loadStaffCall = useCallback(async () => {
    const data = await api.get("/api/customer/staff-call");
    setStaffCallStatus(data.call ? (data.call.status === "ACKED" ? "acked" : "pending") : "idle");
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadMenu(), loadOrders(), loadBill(), loadStaffCall()]);
  }, [loadMenu, loadOrders, loadBill, loadStaffCall]);

  async function requestStaffCall() {
    if (staffCallStatus !== "idle") return;
    setStaffCallStatus("pending");
    try {
      await api.post("/api/customer/staff-call");
    } catch {
      setStaffCallStatus("idle");
    }
  }

  const refreshOrdersAndBill = useCallback(async () => {
    await Promise.all([loadOrders(), loadBill()]);
  }, [loadOrders, loadBill]);

  function markTableClosed() {
    setPhase("closed");
    setClosedMessage("현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요.");
    setCart([]);
    setCartSheetOpen(false);
    setOptionSheetItem(null);
  }

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    (async () => {
      try {
        const data = await api.get(`/api/customer/entry/${slug}`);
        if (cancelled) return;
        if (!data.open) {
          setTableNumber(data.tableNumber);
          setClosedMessage(data.message);
          setPhase("closed");
          return;
        }
        setTableNumber(data.tableNumber);
        setPhase("open");
        void refreshAll();
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // 실시간 동기화: 소켓은 트리거일 뿐이고, 재연결/이벤트 수신 시 항상 REST로 다시 확인한다.
  useEffect(() => {
    if (phase !== "open") return;

    const socket: Socket = io({ withCredentials: true });

    socket.on("connect", () => {
      void refreshOrdersAndBill();
    });
    socket.on(REALTIME_EVENTS.OrderCreated, () => {
      void refreshOrdersAndBill();
    });
    socket.on(REALTIME_EVENTS.OrderStatusChanged, () => {
      void refreshOrdersAndBill();
    });
    socket.on(REALTIME_EVENTS.PaymentRecorded, () => {
      void loadBill();
    });
    socket.on(REALTIME_EVENTS.TableClosed, () => {
      markTableClosed();
    });

    // 실시간 연결이 끊겨도 화면이 멈추지 않도록 짧은 주기의 polling을 함께 둔다.
    const interval = setInterval(() => {
      void refreshOrdersAndBill();
    }, ORDERS_POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function openOptionSheetOrAdd(item: MenuItem) {
    if (item.optionGroups.length === 0) {
      addLineToCart(item, []);
      return;
    }
    setOptionSheetItem(item);
  }

  function addLineToCart(item: MenuItem, optionChoiceIds: string[], quantity = 1) {
    const key = cartLineKey(item.id, optionChoiceIds);
    setCart((prev) => {
      const existing = prev.find((line) => cartLineKey(line.menuItem.id, line.optionChoiceIds) === key);
      if (existing) {
        return prev.map((line) =>
          line.id === existing.id ? { ...line, quantity: line.quantity + quantity } : line,
        );
      }
      return [...prev, { id: crypto.randomUUID(), menuItem: item, quantity, optionChoiceIds }];
    });
  }

  function handleChangeQuantity(lineId: string, quantity: number) {
    if (quantity < 1) return;
    setCart((prev) => prev.map((line) => (line.id === lineId ? { ...line, quantity } : line)));
  }

  function handleRemoveLine(lineId: string) {
    setCart((prev) => prev.filter((line) => line.id !== lineId));
  }

  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = useMemo(
    () => cart.reduce((sum, line) => sum + lineUnitPrice(line) * line.quantity, 0),
    [cart],
  );

  async function submitOrder() {
    if (cart.length === 0 || submitting) return;
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    setSubmitting(true);
    setOrderError(null);
    try {
      await api.post("/api/customer/orders", {
        idempotencyKey: idempotencyKeyRef.current,
        items: cart.map((line) => ({
          menuItemId: line.menuItem.id,
          quantity: line.quantity,
          optionChoiceIds: line.optionChoiceIds,
        })),
      });
      idempotencyKeyRef.current = null;
      setCart([]);
      setCartSheetOpen(false);
      setView("orders");
      await refreshOrdersAndBill();
    } catch (err) {
      setOrderError(err instanceof ApiError ? err.message : "잠시 후 다시 시도해 주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "loading") {
    return (
      <div className="page">
        <div className="loading-center">테이블 정보를 확인하고 있어요...</div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="page">
        <div className="error-panel">
          연결이 원활하지 않아요.
          <br />
          아래 버튼으로 다시 시도해 주세요.
        </div>
        <button type="button" className="btn-primary" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>
          다시 시도하기
        </button>
      </div>
    );
  }

  if (phase === "closed") {
    return (
      <div className="page" style={{ paddingTop: "20vh", textAlign: "center" }}>
        {tableNumber && <div className="table-hero__number">{tableNumber}번 테이블</div>}
        <p className="text-body" style={{ marginTop: 16, color: "var(--color-text-muted)" }}>
          {closedMessage}
        </p>
      </div>
    );
  }

  const activeCategory = categories?.find((cat) => cat.id === activeCategoryId) ?? categories?.[0] ?? null;

  return (
    <div className="page">
      <div className="table-hero">
        <div className="table-hero__number">{tableNumber}번 테이블</div>
        <div className="table-hero__status">
          <span className="table-hero__dot" aria-hidden="true" />
          주문 가능
        </div>
        <button
          type="button"
          className="btn-secondary staff-call-btn"
          disabled={staffCallStatus !== "idle"}
          onClick={requestStaffCall}
        >
          {staffCallStatus === "idle" && "직원 호출하기"}
          {staffCallStatus === "pending" && "호출했어요, 곧 도와드릴게요"}
          {staffCallStatus === "acked" && "직원이 확인했어요"}
        </button>
      </div>

      <div className="seg-tabs" role="tablist" aria-label="화면 전환">
        <button
          type="button"
          className="seg-tab"
          role="tab"
          aria-current={view === "menu"}
          onClick={() => setView("menu")}
        >
          메뉴
        </button>
        <button
          type="button"
          className="seg-tab"
          role="tab"
          aria-current={view === "orders"}
          onClick={() => setView("orders")}
        >
          주문 현황
        </button>
      </div>

      {view === "menu" && (
        <div>
          {menuError && <p className="error-text">{menuError}</p>}
          {categories === null && !menuError && <MenuSkeleton />}

          {categories !== null && categories.length > 0 && (
            <div className="category-tabs" role="tablist" aria-label="메뉴 카테고리">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className="category-tab"
                  role="tab"
                  aria-current={activeCategory?.id === cat.id}
                  onClick={() => setActiveCategoryId(cat.id)}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          )}

          {activeCategory && (
            <div>
              {activeCategory.items.length === 0 && (
                <p className="text-muted">이 카테고리에는 아직 메뉴가 없어요.</p>
              )}
              {activeCategory.items.map((item) => (
                <div key={item.id} className={`menu-row ${item.isSoldOut ? "menu-row--disabled" : ""}`}>
                  <div>
                    <div className="menu-row__name">{item.name}</div>
                    {item.description && <div className="menu-row__desc">{item.description}</div>}
                    <div className="menu-row__price">{item.price.toLocaleString()}원</div>
                    {item.isSoldOut && (
                      <>
                        <span className="badge badge--danger">품절</span>
                        <div className="menu-row__soldout-note">곧 다시 준비할게요</div>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="menu-row__add"
                    disabled={item.isSoldOut}
                    onClick={() => openOptionSheetOrAdd(item)}
                  >
                    담기
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "orders" && (
        <div>
          {bill && (
            <div className="bill-card">
              <div className="bill-card__row">
                <span>주문금액</span>
                <span>{bill.totalAmount.toLocaleString()}원</span>
              </div>
              <div className="bill-card__row">
                <span>이미 결제한 금액</span>
                <span>{bill.paidAmount.toLocaleString()}원</span>
              </div>
              <div className="bill-card__row bill-card__row--total">
                <span>남은 금액</span>
                <span>{bill.remainingAmount.toLocaleString()}원</span>
              </div>
            </div>
          )}

          {orders.length === 0 && <p className="text-muted">아직 주문 내역이 없어요.</p>}

          {orders.map((order) => (
            <div key={order.id} className="order-card">
              <div className="order-card__header">
                <span className="order-card__id">#{order.id.slice(-6).toUpperCase()}</span>
              </div>
              <OrderStatusTimeline
                status={order.status}
                rejectReason={order.rejectReason}
                cancelReason={order.cancelReason}
              />
              {order.items.map((item) => (
                <div key={item.id} className="order-card__item">
                  <span>
                    {item.nameSnapshot} × {item.quantity}
                    {item.options.length > 0 && (
                      <span className="order-card__item-options">
                        {item.options.map((o) => o.nameSnapshot).join(" · ")}
                      </span>
                    )}
                  </span>
                  <span>{(item.unitPrice * item.quantity).toLocaleString()}원</span>
                </div>
              ))}
              {order.note && <div className="order-card__note">요청사항: {order.note}</div>}
            </div>
          ))}
        </div>
      )}

      {view === "menu" && cartCount > 0 && (
        <div className="bottom-cta">
          <button type="button" className="btn-primary" onClick={() => setCartSheetOpen(true)}>
            장바구니 {cartCount}개 · {cartTotal.toLocaleString()}원 확인하기
          </button>
        </div>
      )}

      {optionSheetItem && (
        <OptionSheet
          item={optionSheetItem}
          onClose={() => setOptionSheetItem(null)}
          onConfirm={({ optionChoiceIds, quantity }) => {
            addLineToCart(optionSheetItem, optionChoiceIds, quantity);
            setOptionSheetItem(null);
          }}
        />
      )}

      {cartSheetOpen && (
        <CartSheet
          lines={cart}
          total={cartTotal}
          submitting={submitting}
          error={orderError}
          onClose={() => setCartSheetOpen(false)}
          onChangeQuantity={handleChangeQuantity}
          onRemove={handleRemoveLine}
          onSubmit={submitOrder}
        />
      )}
    </div>
  );
}
