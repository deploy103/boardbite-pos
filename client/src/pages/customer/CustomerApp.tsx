import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";

interface OptionChoice {
  id: string;
  name: string;
  extraPrice: number;
}
interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  multiSelect: boolean;
  choices: OptionChoice[];
}
interface MenuItem {
  id: string;
  name: string;
  price: number;
  description: string | null;
  isSoldOut: boolean;
  optionGroups: OptionGroup[];
}
interface MenuCategory {
  id: string;
  name: string;
  items: MenuItem[];
}
interface CartLine {
  menuItem: MenuItem;
  quantity: number;
  optionChoiceIds: string[];
}

const ORDER_STATUS_LABEL: Record<string, string> = {
  NEW: "주문 확인 중",
  ACCEPTED: "주문 접수",
  PREPARING: "조리 중",
  READY: "준비 완료",
  SERVED: "서빙 완료",
  REJECTED: "주문 거부됨",
  CANCELLED: "주문 취소됨",
};

export default function CustomerApp() {
  const { slug } = useParams();
  const [phase, setPhase] = useState<"loading" | "closed" | "open">("loading");
  const [closedMessage, setClosedMessage] = useState("");
  const [tableNumber, setTableNumber] = useState<number | null>(null);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [bill, setBill] = useState<{ totalAmount: number; paidAmount: number; remainingAmount: number } | null>(null);
  const [view, setView] = useState<"menu" | "orders">("menu");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    api
      .get(`/api/customer/entry/${slug}`)
      .then(async (data) => {
        if (!data.open) {
          setClosedMessage(data.message);
          setTableNumber(data.tableNumber);
          setPhase("closed");
          return;
        }
        setTableNumber(data.tableNumber);
        setPhase("open");
        await Promise.all([loadMenu(), loadOrders(), loadBill()]);
      })
      .catch(() => {
        setClosedMessage("현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요.");
        setPhase("closed");
      });
  }, [slug]);

  async function loadMenu() {
    const data = await api.get("/api/customer/menu");
    setCategories(data.categories);
  }
  async function loadOrders() {
    const data = await api.get("/api/customer/orders");
    setOrders(data.orders);
  }
  async function loadBill() {
    const data = await api.get("/api/customer/session");
    setBill(data.bill);
  }

  function addToCart(item: MenuItem) {
    setCart((prev) => [...prev, { menuItem: item, quantity: 1, optionChoiceIds: [] }]);
  }

  const cartCount = cart.reduce((sum, l) => sum + l.quantity, 0);
  const cartTotal = useMemo(
    () =>
      cart.reduce((sum, l) => {
        const optionsSum = l.optionChoiceIds.reduce((s, id) => {
          const choice = l.menuItem.optionGroups.flatMap((g) => g.choices).find((c) => c.id === id);
          return s + (choice?.extraPrice ?? 0);
        }, 0);
        return sum + (l.menuItem.price + optionsSum) * l.quantity;
      }, 0),
    [cart],
  );

  async function submitOrder() {
    if (cart.length === 0) return;
    try {
      await api.post("/api/customer/orders", {
        idempotencyKey: crypto.randomUUID(),
        items: cart.map((l) => ({
          menuItemId: l.menuItem.id,
          quantity: l.quantity,
          optionChoiceIds: l.optionChoiceIds,
        })),
      });
      setCart([]);
      setView("orders");
      await Promise.all([loadOrders(), loadBill()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "주문 처리 중 오류가 발생했어요.");
    }
  }

  if (phase === "loading") return <div className="page">불러오는 중...</div>;

  if (phase === "closed") {
    return (
      <div className="page" style={{ paddingTop: "30vh", textAlign: "center" }}>
        {tableNumber && <div className="table-badge">{tableNumber}번 테이블</div>}
        <p style={{ marginTop: 16 }}>{closedMessage}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="table-badge">{tableNumber}번 테이블</div>
      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <button className="btn-secondary" onClick={() => setView("menu")} disabled={view === "menu"}>
          메뉴
        </button>
        <button className="btn-secondary" onClick={() => setView("orders")} disabled={view === "orders"}>
          주문 현황
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {view === "menu" &&
        categories.map((cat) => (
          <div key={cat.id} style={{ marginBottom: 24 }}>
            <h2>{cat.name}</h2>
            {cat.items.map((item) => (
              <div key={item.id} className={`list-row ${item.isSoldOut ? "list-row--disabled" : ""}`}>
                <div>
                  <div>{item.name}</div>
                  <div className="text-muted">{item.price.toLocaleString()}원</div>
                  {item.isSoldOut && <span className="badge badge--danger">품절</span>}
                </div>
                <button className="btn-secondary" disabled={item.isSoldOut} onClick={() => addToCart(item)}>
                  담기
                </button>
              </div>
            ))}
          </div>
        ))}

      {view === "orders" && (
        <div>
          {bill && (
            <div className="table-card" style={{ marginBottom: 16 }}>
              <div>주문금액 {bill.totalAmount.toLocaleString()}원</div>
              <div>결제한 금액 {bill.paidAmount.toLocaleString()}원</div>
              <div>
                <strong>남은 금액 {bill.remainingAmount.toLocaleString()}원</strong>
              </div>
            </div>
          )}
          {orders.map((order) => (
            <div key={order.id} className="table-card" style={{ marginBottom: 12 }}>
              <span className="badge">{ORDER_STATUS_LABEL[order.status] ?? order.status}</span>
              {order.items.map((item: any) => (
                <div key={item.id}>
                  {item.nameSnapshot} × {item.quantity}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {view === "menu" && cartCount > 0 && (
        <div className="bottom-cta">
          <button className="btn-primary" onClick={submitOrder}>
            장바구니 {cartCount}개 · {cartTotal.toLocaleString()}원 주문하기
          </button>
        </div>
      )}
    </div>
  );
}
