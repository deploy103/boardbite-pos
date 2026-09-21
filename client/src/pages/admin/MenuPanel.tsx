import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.js";
import DangerConfirmModal from "../../components/DangerConfirmModal.js";
import { useErrorBanner } from "./shared.js";

type Channel = "TABLE" | "FRONT" | "BOTH";

const CHANNEL_LABEL: Record<Channel, string> = {
  TABLE: "테이블 전용",
  FRONT: "FRONT 전용",
  BOTH: "공통",
};

interface OptionChoice {
  id: string;
  name: string;
  extraPrice: number;
  isActive: boolean;
  sortOrder: number;
  /** 연결된 재고 품목. 이 메뉴가 품절되면 선택지도 자동 품절이 된다. */
  linkedMenuItemId: string | null;
  linkedMenuItem: { id: string; name: string; isSoldOut: boolean } | null;
  isSoldOut: boolean;
  soldOutReason: string | null;
}

interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  multiSelect: boolean;
  isActive: boolean;
  sortOrder: number;
  choices: OptionChoice[];
}

interface AdminMenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  price: number;
  isActive: boolean;
  isSoldOut: boolean;
  needsCooking: boolean;
  showInKitchen: boolean;
  channel: Channel;
  sortOrder: number;
  optionGroups: OptionGroup[];
  /** 필수 그룹에 고를 선택지가 없어 지금은 팔 수 없는 상태. */
  blockedRequiredGroups: string[];
}

interface AdminCategory {
  id: string;
  name: string;
  sortOrder: number;
  items: AdminMenuItem[];
}

interface DeletePreview {
  item: { id: string; name: string };
  orderedCount: number;
  coupons: { count: number; soleTargetCount: number; codes: string[] };
}

/**
 * 위/아래 한 칸 이동 버튼. 번호를 직접 입력하는 대신 순서를 눈으로 보며 바꾼다.
 * 서버에는 **새 순서 전체**를 보내고 서버가 0..n-1로 다시 매기므로 번호가 겹칠 일이 없다.
 */
function MoveButtons({
  index,
  total,
  onMove,
  label,
}: {
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  label: string;
}) {
  return (
    <span className="sort-buttons">
      <button
        type="button"
        className="sort-btn"
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
        aria-label={`${label} 위로`}
        title="위로"
      >
        ↑
      </button>
      <button
        type="button"
        className="sort-btn"
        disabled={index === total - 1}
        onClick={() => onMove(index, index + 1)}
        aria-label={`${label} 아래로`}
        title="아래로"
      >
        ↓
      </button>
    </span>
  );
}

/** 배열에서 한 칸 옮긴 새 순서를 만든다(원본은 건드리지 않는다). */
function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * 메뉴/카테고리/옵션 관리(요구사항.md §3.1, §4).
 *
 * 여기서 DB를 직접 고칠 일이 없어야 한다 — 옵션 그룹·선택지 생성/수정/정렬/삭제,
 * 판매 채널, 조리·주방 표시, 카테고리 이동, 논리 삭제가 전부 화면에서 가능하다.
 * 삭제는 전부 논리 삭제라 과거 주문/결제/쿠폰 이력은 그대로 남는다.
 */
export default function MenuPanel() {
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [catName, setCatName] = useState("");
  const [itemForm, setItemForm] = useState({ categoryId: "", name: "", price: "", channel: "BOTH" as Channel });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeletePreview | null>(null);
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<AdminCategory | null>(null);
  const { error, setError, wrap } = useErrorBanner();

  const refresh = useCallback(
    () => api.get("/api/staff/admin/menu/categories").then((d) => setCategories(d.categories)),
    [],
  );
  useEffect(() => {
    refresh().catch(() => setError("메뉴를 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addCategory = wrap(async () => {
    if (!catName.trim()) return;
    await api.post("/api/staff/admin/menu/categories", { name: catName.trim() });
    setCatName("");
    await refresh();
  });

  const addItem = wrap(async () => {
    if (!itemForm.categoryId || !itemForm.name.trim() || itemForm.price === "") return;
    await api.post("/api/staff/admin/menu/items", {
      categoryId: itemForm.categoryId,
      name: itemForm.name.trim(),
      price: Number(itemForm.price),
      channel: itemForm.channel,
    });
    setItemForm({ ...itemForm, name: "", price: "" });
    await refresh();
  });

  /** 새 순서 전체를 서버에 보내고 목록을 다시 읽는다. */
  const reorder = (path: string, ids: string[]) =>
    wrap(async () => {
      await api.post(path, { ids });
      await refresh();
    })();

  const patchItem = (id: string, data: Record<string, unknown>) =>
    wrap(async () => {
      await api.patch(`/api/staff/admin/menu/items/${id}`, data);
      await refresh();
    })();

  const openDeleteItem = (item: AdminMenuItem) =>
    wrap(async () => {
      setDeleteTarget(await api.get(`/api/staff/admin/menu/items/${item.id}/delete-preview`));
    })();

  const confirmDeleteItem = () =>
    wrap(async () => {
      if (!deleteTarget) return;
      const id = deleteTarget.item.id;
      setDeleteTarget(null);
      await api.del(`/api/staff/admin/menu/items/${id}`);
      await refresh();
    })();

  const deleteCategory = (category: AdminCategory) =>
    wrap(async () => {
      await api.del(`/api/staff/admin/menu/categories/${category.id}`);
      setDeleteCategoryTarget(null);
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
        min={0}
        value={itemForm.price}
        onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })}
      />
      <select
        className="field"
        value={itemForm.channel}
        onChange={(e) => setItemForm({ ...itemForm, channel: e.target.value as Channel })}
      >
        <option value="BOTH">공통 (손님 테이블 + FRONT 현장)</option>
        <option value="TABLE">테이블 전용 (손님만)</option>
        <option value="FRONT">FRONT 전용 (룰렛/보드게임/닌텐도/음료 등)</option>
      </select>
      <button className="btn-primary" onClick={addItem}>
        메뉴 추가
      </button>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        추가한 뒤 각 메뉴의 <strong>편집</strong>에서 조리 여부와 옵션을 설정하세요. 룰렛·보드게임·닌텐도처럼 바로
        제공하는 상품은 '조리 필요'와 '주방 표시'를 모두 끄면 주방 대기를 만들지 않습니다.
      </p>

      {error && <p className="error-text">{error}</p>}

      {categories.map((c) => (
        <div key={c.id} style={{ marginTop: 24 }}>
          <CategoryHeader category={c} onChanged={refresh} onDelete={() => setDeleteCategoryTarget(c)} onError={setError} />
          {c.items.length === 0 && <p className="text-muted">메뉴가 없어요.</p>}
          {c.items.map((item, itemIndex) => (
            <div key={item.id} className={`list-row ${item.isSoldOut ? "list-row--disabled" : ""}`} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <MoveButtons
                    index={itemIndex}
                    total={c.items.length}
                    label={item.name}
                    onMove={(from, to) =>
                      reorder(`/api/staff/admin/menu/categories/${c.id}/reorder-items`, moved(c.items, from, to).map((i) => i.id))
                    }
                  />
                  <div>
                  <strong>{item.name}</strong> · {item.price.toLocaleString()}원{" "}
                  <span className="badge">{CHANNEL_LABEL[item.channel]}</span>{" "}
                  <span className="badge">{item.needsCooking || item.showInKitchen ? "주방" : "현장 제공"}</span>{" "}
                  {item.isSoldOut && <span className="badge badge--danger">품절</span>}{" "}
                  {!item.isActive && <span className="badge badge--warn">숨김</span>}{" "}
                  {item.optionGroups.length > 0 && <span className="badge">옵션 {item.optionGroups.length}</span>}
                  {item.blockedRequiredGroups.length > 0 && (
                    <div className="error-text">
                      '{item.blockedRequiredGroups.join(", ")}' 필수 옵션을 지금 고를 수 없어(품절이거나 선택지가 없어)
                      이 메뉴는 판매되지 않아요. 선택지를 추가하거나 품절을 풀어 주세요.
                    </div>
                  )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn-secondary" onClick={() => patchItem(item.id, { isSoldOut: !item.isSoldOut })}>
                    {item.isSoldOut ? "품절 해제" : "품절 처리"}
                  </button>
                  <button className="btn-secondary" onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
                    {expanded === item.id ? "닫기" : "편집"}
                  </button>
                  <button className="btn-danger-outline" onClick={() => openDeleteItem(item)}>
                    삭제
                  </button>
                </div>
              </div>

              {expanded === item.id && (
                <MenuItemEditor
                  item={item}
                  categories={categories}
                  onChanged={refresh}
                  onError={(m) => setError(m)}
                />
              )}
            </div>
          ))}
        </div>
      ))}

      {deleteTarget && (
        <DangerConfirmModal
          title={`${deleteTarget.item.name} 삭제`}
          description="판매 목록에서 사라지고 새 주문을 받을 수 없게 됩니다. 과거 주문·결제·환불·쿠폰 사용 이력은 그대로 남습니다(기록이 지워지지 않아요)."
          details={[
            { label: "과거 주문 항목", value: `${deleteTarget.orderedCount}건 (그대로 보존)` },
            {
              label: "이 메뉴가 대상인 미사용 상품권",
              value:
                deleteTarget.coupons.count === 0
                  ? "없음"
                  : `${deleteTarget.coupons.count}장 (이 메뉴만 대상: ${deleteTarget.coupons.soleTargetCount}장)`,
            },
          ]}
          confirmLabel="삭제하기"
          onConfirm={confirmDeleteItem}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {deleteCategoryTarget && (
        <DangerConfirmModal
          title={`${deleteCategoryTarget.name} 카테고리 삭제`}
          description="소속 메뉴가 남아 있으면 삭제되지 않습니다. 메뉴를 먼저 다른 카테고리로 옮기거나 삭제해 주세요 — 카테고리를 지운다고 메뉴가 함께 지워지지는 않습니다."
          details={[{ label: "남은 메뉴", value: `${deleteCategoryTarget.items.length}개` }]}
          confirmLabel="카테고리 삭제"
          onConfirm={() => deleteCategory(deleteCategoryTarget)}
          onCancel={() => setDeleteCategoryTarget(null)}
        />
      )}
    </section>
  );
}

/** 카테고리 머리글 — 이름과 정렬 순서를 그 자리에서 고친다(DB를 직접 건드릴 일이 없도록). */
function CategoryHeader({
  category,
  onChanged,
  onDelete,
  onError,
}: {
  category: AdminCategory;
  onChanged: () => Promise<void>;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [sortOrder, setSortOrder] = useState(String(category.sortOrder));

  async function save() {
    try {
      await api.patch(`/api/staff/admin/menu/categories/${category.id}`, {
        name: name.trim(),
        sortOrder: Number(sortOrder) || 0,
      });
      setEditing(false);
      await onChanged();
    } catch (err) {
      onError(errorMessage(err, "카테고리를 저장하지 못했어요."));
    }
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {editing ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="field"
            style={{ marginBottom: 0, maxWidth: 200 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="카테고리 이름"
          />
          <input
            className="field"
            style={{ marginBottom: 0, width: 100 }}
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            aria-label="카테고리 정렬 순서"
          />
          <button className="btn-primary" style={{ width: "auto", padding: "0 16px" }} onClick={save} disabled={!name.trim()}>
            저장
          </button>
          <button className="btn-secondary" style={{ width: "auto", padding: "0 16px" }} onClick={() => setEditing(false)}>
            취소
          </button>
        </div>
      ) : (
        <h3 style={{ margin: 0 }}>
          {category.name} <span className="text-muted">({category.items.length}개)</span>
        </h3>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        {!editing && (
          <button className="btn-secondary" onClick={() => setEditing(true)}>
            이름/순서 변경
          </button>
        )}
        <button className="btn-danger-outline" onClick={onDelete}>
          카테고리 삭제
        </button>
      </div>
    </div>
  );
}

/** 메뉴 한 건의 상세 편집 + 옵션 그룹/선택지 관리. */
function MenuItemEditor({
  item,
  categories,
  onChanged,
  onError,
}: {
  item: AdminMenuItem;
  categories: AdminCategory[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  // 선택지에 연결할 수 있는 후보 = 삭제되지 않은 모든 메뉴.
  const allMenuItems = categories.flatMap((c) => c.items).map((i) => ({ id: i.id, name: i.name, isSoldOut: i.isSoldOut }));
  const [form, setForm] = useState({
    name: item.name,
    price: String(item.price),
    description: item.description ?? "",
    categoryId: item.categoryId,
    channel: item.channel,
    needsCooking: item.needsCooking,
    showInKitchen: item.showInKitchen,
    isActive: item.isActive,
    sortOrder: String(item.sortOrder),
  });
  const [groupName, setGroupName] = useState("");
  const [saving, setSaving] = useState(false);

  async function call(fn: () => Promise<unknown>) {
    setSaving(true);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError(errorMessage(err, "저장하지 못했어요."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-menu-editor">
      <div className="field-label-group">
        <label className="field-label" htmlFor={`name-${item.id}`}>
          메뉴명
        </label>
        <input
          id={`name-${item.id}`}
          className="field"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div className="field-label-group">
        <label className="field-label" htmlFor={`price-${item.id}`}>
          가격(원)
        </label>
        <input
          id={`price-${item.id}`}
          className="field"
          type="number"
          min={0}
          value={form.price}
          onChange={(e) => setForm({ ...form, price: e.target.value })}
        />
      </div>
      <div className="field-label-group">
        <label className="field-label" htmlFor={`desc-${item.id}`}>
          설명
        </label>
        <input
          id={`desc-${item.id}`}
          className="field"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <div className="field-label-group">
        <label className="field-label" htmlFor={`cat-${item.id}`}>
          카테고리 (이동)
        </label>
        <select
          id={`cat-${item.id}`}
          className="field"
          value={form.categoryId}
          onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field-label-group">
        <label className="field-label" htmlFor={`channel-${item.id}`}>
          판매 채널
        </label>
        <select
          id={`channel-${item.id}`}
          className="field"
          value={form.channel}
          onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })}
        >
          <option value="BOTH">공통</option>
          <option value="TABLE">테이블 전용</option>
          <option value="FRONT">FRONT 전용</option>
        </select>
      </div>
      <div className="field-label-group">
        <label className="field-label" htmlFor={`sort-${item.id}`}>
          정렬 순서
        </label>
        <input
          id={`sort-${item.id}`}
          className="field"
          type="number"
          value={form.sortOrder}
          onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
        />
      </div>

      <label className="option-choice">
        <input
          type="checkbox"
          checked={form.needsCooking}
          onChange={(e) => setForm({ ...form, needsCooking: e.target.checked, showInKitchen: e.target.checked ? true : form.showInKitchen })}
        />
        <span className="option-choice__name">조리 필요 (주방에서 만들고 READY 후 전달)</span>
      </label>
      <label className="option-choice">
        <input
          type="checkbox"
          checked={form.showInKitchen}
          disabled={form.needsCooking}
          onChange={(e) => setForm({ ...form, showInKitchen: e.target.checked })}
        />
        <span className="option-choice__name">주방 화면(KDS)에 표시</span>
      </label>
      <label className="option-choice">
        <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
        <span className="option-choice__name">판매 목록에 표시</span>
      </label>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        둘 다 끄면 <strong>현장 즉시 제공</strong> 상품이 되어 조리 대기를 만들지 않습니다(룰렛·보드게임·닌텐도 등).
        조리가 필요한 메뉴는 주방 표시를 끌 수 없습니다.
      </p>

      <button
        className="btn-primary"
        disabled={saving}
        onClick={() =>
          call(() =>
            api.patch(`/api/staff/admin/menu/items/${item.id}`, {
              name: form.name,
              price: Number(form.price),
              description: form.description || null,
              categoryId: form.categoryId,
              channel: form.channel,
              needsCooking: form.needsCooking,
              showInKitchen: form.showInKitchen,
              isActive: form.isActive,
              sortOrder: Number(form.sortOrder) || 0,
            }),
          )
        }
      >
        메뉴 저장
      </button>

      <h4 style={{ marginTop: 20 }}>옵션 그룹</h4>
      <p className="text-muted" style={{ fontSize: "0.85rem" }}>
        ↑↓ 로 손님에게 보이는 순서를 바꿉니다. 선택지에 <strong>재고 메뉴를 연결</strong>해 두면 그 메뉴를 품절
        처리할 때 이 옵션도 자동으로 품절이 됩니다.
      </p>
      {item.optionGroups.length === 0 && <p className="text-muted">옵션이 없어요. 아래에서 그룹을 추가하세요.</p>}
      {item.optionGroups.map((group, groupIndex) => (
        <OptionGroupEditor
          key={group.id}
          menuItemId={item.id}
          group={group}
          index={groupIndex}
          total={item.optionGroups.length}
          allMenuItems={allMenuItems}
          saving={saving}
          onCall={call}
          onReorderGroups={(from, to) =>
            call(() =>
              api.post(`/api/staff/admin/menu/items/${item.id}/reorder-option-groups`, {
                ids: moved(item.optionGroups, from, to).map((g) => g.id),
              }),
            )
          }
        />
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          className="field"
          style={{ marginBottom: 0 }}
          placeholder="새 옵션 그룹 이름 (예: 종류, 재료 요청, 추가 토핑)"
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
        />
        <button
          className="btn-secondary"
          disabled={!groupName.trim() || saving}
          onClick={() =>
            call(async () => {
              await api.post(`/api/staff/admin/menu/items/${item.id}/option-groups`, { name: groupName.trim() });
              setGroupName("");
            })
          }
        >
          그룹 추가
        </button>
      </div>
    </div>
  );
}

function OptionGroupEditor({
  menuItemId,
  group,
  index,
  total,
  allMenuItems,
  saving,
  onCall,
  onReorderGroups,
}: {
  menuItemId: string;
  group: OptionGroup;
  index: number;
  total: number;
  allMenuItems: { id: string; name: string; isSoldOut: boolean }[];
  saving: boolean;
  onCall: (fn: () => Promise<unknown>) => Promise<void>;
  onReorderGroups: (from: number, to: number) => void;
}) {
  const [name, setName] = useState(group.name);
  const [choice, setChoice] = useState({ name: "", extraPrice: "0" });
  const base = `/api/staff/admin/menu/items/${menuItemId}/option-groups/${group.id}`;

  return (
    <div className="admin-option-group">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="field" style={{ marginBottom: 0, maxWidth: 220 }} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="option-choice" style={{ border: "none", padding: 0 }}>
          <input
            type="checkbox"
            checked={group.required}
            onChange={(e) => onCall(() => api.patch(base, { required: e.target.checked }))}
          />
          <span className="option-choice__name">필수</span>
        </label>
        <label className="option-choice" style={{ border: "none", padding: 0 }}>
          <input
            type="checkbox"
            checked={group.multiSelect}
            onChange={(e) => onCall(() => api.patch(base, { multiSelect: e.target.checked }))}
          />
          <span className="option-choice__name">복수 선택</span>
        </label>
        <label className="option-choice" style={{ border: "none", padding: 0 }}>
          <input
            type="checkbox"
            checked={group.isActive}
            onChange={(e) => onCall(() => api.patch(base, { isActive: e.target.checked }))}
          />
          <span className="option-choice__name">사용</span>
        </label>
        <MoveButtons index={index} total={total} label={`${group.name} 그룹`} onMove={onReorderGroups} />
        <button className="btn-secondary" disabled={saving || name === group.name} onClick={() => onCall(() => api.patch(base, { name }))}>
          이름 저장
        </button>
        <button className="btn-danger-outline" disabled={saving} onClick={() => onCall(() => api.del(base))}>
          그룹 삭제
        </button>
      </div>

      {group.choices.length === 0 && <p className="error-text">선택지가 없어요. 필수 그룹이면 이 메뉴는 판매되지 않습니다.</p>}
      {group.choices.map((c, choiceIndex) => {
        const choiceBase = `/api/staff/admin/menu/option-groups/${group.id}/choices/${c.id}`;
        return (
          <div key={c.id} className={`admin-option-choice ${c.isSoldOut ? "admin-option-choice--sold-out" : ""}`}>
            <MoveButtons
              index={choiceIndex}
              total={group.choices.length}
              label={c.name}
              onMove={(from, to) =>
                onCall(() =>
                  api.post(`/api/staff/admin/menu/option-groups/${group.id}/reorder-choices`, {
                    ids: moved(group.choices, from, to).map((x) => x.id),
                  }),
                )
              }
            />
            <input
              className="field"
              style={{ marginBottom: 0 }}
              defaultValue={c.name}
              onBlur={(e) => e.target.value !== c.name && onCall(() => api.patch(choiceBase, { name: e.target.value }))}
              aria-label="옵션 이름"
            />
            <input
              className="field"
              style={{ marginBottom: 0, width: 110 }}
              type="number"
              min={0}
              defaultValue={c.extraPrice}
              onBlur={(e) =>
                Number(e.target.value) !== c.extraPrice &&
                onCall(() => api.patch(choiceBase, { extraPrice: Number(e.target.value) || 0 }))
              }
              aria-label="추가금(원)"
            />
            {/* 재고 메뉴를 연결하면 그 메뉴를 품절 처리할 때 이 선택지도 자동으로 품절이 된다. */}
            <select
              className="field"
              style={{ marginBottom: 0, maxWidth: 170 }}
              value={c.linkedMenuItemId ?? ""}
              onChange={(e) =>
                onCall(() => api.post(`${choiceBase}/stock-link`, { linkedMenuItemId: e.target.value || null }))
              }
              aria-label={`${c.name} 재고 메뉴 연결`}
            >
              <option value="">재고 연결 없음</option>
              {allMenuItems.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.isSoldOut ? " (품절)" : ""}
                </option>
              ))}
            </select>
            {c.isSoldOut && <span className="badge badge--danger">품절 · {c.soldOutReason}</span>}
            <label className="option-choice" style={{ border: "none", padding: 0 }}>
              <input
                type="checkbox"
                checked={c.isActive}
                onChange={(e) => onCall(() => api.patch(choiceBase, { isActive: e.target.checked }))}
              />
              <span className="option-choice__name">사용</span>
            </label>
            <button className="btn-danger-outline" disabled={saving} onClick={() => onCall(() => api.del(choiceBase))}>
              삭제
            </button>
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <input
          className="field"
          style={{ marginBottom: 0 }}
          placeholder="선택지 이름 (예: 신라면, 계란 추가)"
          value={choice.name}
          onChange={(e) => setChoice({ ...choice, name: e.target.value })}
        />
        <input
          className="field"
          style={{ marginBottom: 0, width: 130 }}
          type="number"
          min={0}
          placeholder="추가금"
          value={choice.extraPrice}
          onChange={(e) => setChoice({ ...choice, extraPrice: e.target.value })}
        />
        <button
          className="btn-secondary"
          disabled={!choice.name.trim() || saving}
          onClick={() =>
            onCall(async () => {
              await api.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`, {
                name: choice.name.trim(),
                extraPrice: Number(choice.extraPrice) || 0,
              });
              setChoice({ name: "", extraPrice: "0" });
            })
          }
        >
          선택지 추가
        </button>
      </div>
    </div>
  );
}
