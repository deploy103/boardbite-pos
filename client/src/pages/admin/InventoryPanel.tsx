import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import DangerConfirmModal from "../../components/DangerConfirmModal.js";
import { useErrorBanner } from "./shared.js";

interface InventoryRow {
  id: string;
  name: string;
  note: string | null;
  isSoldOut: boolean;
  soldOutAt: string | null;
  soldOutBy: string | null;
  menuItems: { id: string; name: string }[];
  optionChoices: { id: string; name: string; groupName: string; menuItemName: string }[];
  usageCount: number;
}

interface MenuChoice {
  id: string;
  name: string;
  optionGroups: { id: string; name: string; choices: { id: string; name: string; inventoryItemId: string | null }[] }[];
  inventoryItemId: string | null;
}

const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });

/**
 * 공용 재고 물품 관리(요구사항 4.4).
 *
 * 메뉴와 옵션이 같은 물품을 참조하면 품절 상태를 공유한다 — 어느 쪽에서 품절 처리하든
 * 같은 물품을 쓰는 모든 항목이 동시에 막힌다. 품절 값을 복사해 두지 않으므로 어긋날 수 없다.
 */
export default function InventoryPanel() {
  const [items, setItems] = useState<InventoryRow[]>([]);
  const [menus, setMenus] = useState<MenuChoice[]>([]);
  const [newName, setNewName] = useState("");
  const [toggleTarget, setToggleTarget] = useState<{ row: InventoryRow; soldOut: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InventoryRow | null>(null);
  const [busy, setBusy] = useState(false);
  const { error, setError, wrap } = useErrorBanner();

  const refresh = useCallback(async () => {
    const [inv, menu] = await Promise.all([
      api.get("/api/staff/admin/inventory"),
      api.get("/api/staff/admin/menu/categories"),
    ]);
    setItems(inv.items);
    setMenus((menu.categories as { items: MenuChoice[] }[]).flatMap((c) => c.items));
  }, []);

  useEffect(() => {
    refresh().catch(() => setError("재고 물품을 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = wrap(async () => {
    if (!newName.trim()) return;
    await api.post("/api/staff/admin/inventory", { name: newName.trim() });
    setNewName("");
    await refresh();
  });

  /** 품절/판매 재개 — 되돌리기 쉬운 작업이지만 영향 범위가 넓어 확인을 한 번 받는다. */
  const confirmToggle = wrap(async () => {
    if (!toggleTarget) return;
    const { row, soldOut } = toggleTarget;
    setToggleTarget(null);
    setBusy(true);
    try {
      // 물품에 연결된 항목 중 아무거나 하나를 대상으로 보내면 서버가 물품 전체를 바꾼다.
      const target = row.menuItems[0]
        ? { kind: "MENU_ITEM" as const, id: row.menuItems[0].id }
        : row.optionChoices[0]
          ? { kind: "OPTION_CHOICE" as const, id: row.optionChoices[0].id }
          : null;
      if (!target) {
        setError("이 물품에 연결된 메뉴나 옵션이 없어요. 먼저 연결해 주세요.");
        return;
      }
      await api.post("/api/staff/admin/inventory/sold-out", { targets: [target], soldOut });
      await refresh();
    } finally {
      setBusy(false);
    }
  });

  const link = (kind: "MENU_ITEM" | "OPTION_CHOICE", id: string, inventoryItemId: string | null) =>
    wrap(async () => {
      await api.post("/api/staff/admin/inventory/link", { kind, id, inventoryItemId });
      await refresh();
    })();

  const remove = wrap(async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    await api.del(`/api/staff/admin/inventory/${id}`);
    await refresh();
  });

  return (
    <section>
      <h2>공용 재고 물품</h2>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        여러 메뉴와 옵션이 같은 재료를 쓸 때 물품 하나로 묶습니다. 예: <strong>계란</strong> 물품에 «계란» 메뉴,
        «라면 &gt; 계란 추가», «우동 &gt; 계란 추가»를 연결해 두면 <strong>한 번만 품절 처리해도 전부 막힙니다.</strong>
        연결하지 않은 메뉴·옵션은 각자 따로 품절 처리하면 됩니다.
      </p>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="field"
          placeholder="물품 이름 (예: 계란)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <button className="btn-primary" style={{ width: 140 }} onClick={create}>
          물품 추가
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}

      {items.length === 0 && <p className="text-muted">등록된 공용 물품이 없어요.</p>}
      {items.map((row) => (
        <div key={row.id} className={`list-row ${row.isSoldOut ? "list-row--disabled" : ""}`} style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div>
              <strong>{row.name}</strong>{" "}
              {row.isSoldOut ? <span className="badge badge--danger">품절</span> : <span className="badge">판매 중</span>}{" "}
              <span className="badge">{row.usageCount}곳 사용</span>
              {row.isSoldOut && row.soldOutAt && (
                <div className="text-muted">
                  {kst(row.soldOutAt)} · {row.soldOutBy ?? "-"}
                </div>
              )}
              <div className="text-muted">
                {row.menuItems.map((m) => `메뉴 ${m.name}`).join(", ")}
                {row.menuItems.length > 0 && row.optionChoices.length > 0 && " / "}
                {row.optionChoices.map((c) => `${c.menuItemName}>${c.name}`).join(", ")}
                {row.usageCount === 0 && "연결된 항목 없음"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className={row.isSoldOut ? "btn-secondary" : "btn-danger-outline"}
                disabled={busy || row.usageCount === 0}
                onClick={() => setToggleTarget({ row, soldOut: !row.isSoldOut })}
              >
                {row.isSoldOut ? "판매 재개" : "품절 처리"}
              </button>
              <button className="btn-danger-outline" onClick={() => setDeleteTarget(row)}>
                삭제
              </button>
            </div>
          </div>
        </div>
      ))}

      <h3 style={{ marginTop: 32 }}>메뉴·옵션 연결</h3>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        각 항목을 어떤 공용 물품에 묶을지 고릅니다. <strong>연결 없음</strong>이면 그 항목만 따로 품절 처리됩니다.
      </p>
      {menus.map((menu) => (
        <div key={menu.id} className="list-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div className="admin-option-choice">
            <strong style={{ minWidth: 120 }}>{menu.name}</strong>
            <span className="text-muted">메뉴</span>
            <select
              className="field"
              style={{ marginBottom: 0, maxWidth: 200 }}
              value={menu.inventoryItemId ?? ""}
              onChange={(e) => link("MENU_ITEM", menu.id, e.target.value || null)}
              aria-label={`${menu.name} 재고 물품 연결`}
            >
              <option value="">연결 없음</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.isSoldOut ? " (품절)" : ""}
                </option>
              ))}
            </select>
          </div>
          {menu.optionGroups.flatMap((g) =>
            g.choices.map((c) => (
              <div key={c.id} className="admin-option-choice">
                <span style={{ minWidth: 120 }}>
                  {g.name} &gt; {c.name}
                </span>
                <span className="text-muted">옵션</span>
                <select
                  className="field"
                  style={{ marginBottom: 0, maxWidth: 200 }}
                  value={c.inventoryItemId ?? ""}
                  onChange={(e) => link("OPTION_CHOICE", c.id, e.target.value || null)}
                  aria-label={`${c.name} 재고 물품 연결`}
                >
                  <option value="">연결 없음</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                      {i.isSoldOut ? " (품절)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )),
          )}
        </div>
      ))}

      {toggleTarget && (
        <DangerConfirmModal
          title={`${toggleTarget.row.name} ${toggleTarget.soldOut ? "품절 처리" : "판매 재개"}`}
          description={
            toggleTarget.soldOut
              ? "이 물품을 쓰는 메뉴와 옵션이 손님 화면에서 모두 선택 불가로 바뀝니다. 되돌리려면 판매 재개를 누르면 됩니다."
              : "이 물품을 쓰는 메뉴와 옵션이 모두 다시 주문 가능해집니다."
          }
          details={[
            { label: "영향받는 메뉴", value: `${toggleTarget.row.menuItems.length}개` },
            { label: "영향받는 옵션", value: `${toggleTarget.row.optionChoices.length}개` },
          ]}
          confirmLabel={toggleTarget.soldOut ? "품절 처리" : "판매 재개"}
          onConfirm={confirmToggle}
          onCancel={() => setToggleTarget(null)}
        />
      )}

      {deleteTarget && (
        <DangerConfirmModal
          title={`${deleteTarget.name} 물품 삭제`}
          description="연결된 메뉴나 옵션이 남아 있으면 삭제되지 않습니다. 먼저 연결을 끊어 주세요. 삭제는 논리 삭제라 과거 기록은 그대로 남습니다."
          details={[{ label: "현재 연결", value: `${deleteTarget.usageCount}곳` }]}
          confirmLabel="삭제하기"
          onConfirm={remove}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
