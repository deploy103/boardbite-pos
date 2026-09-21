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
          {c.items.map((item) => (
            <div key={item.id} className={`list-row ${item.isSoldOut ? "list-row--disabled" : ""}`} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <strong>{item.name}</strong> · {item.price.toLocaleString()}원{" "}
                  <span className="badge">{CHANNEL_LABEL[item.channel]}</span>{" "}
                  <span className="badge">{item.needsCooking || item.showInKitchen ? "주방" : "현장 제공"}</span>{" "}
                  {item.isSoldOut && <span className="badge badge--danger">품절</span>}{" "}
                  {!item.isActive && <span className="badge badge--warn">숨김</span>}{" "}
                  {item.optionGroups.length > 0 && <span className="badge">옵션 {item.optionGroups.length}</span>}
                  {item.blockedRequiredGroups.length > 0 && (
                    <div className="error-text">
                      '{item.blockedRequiredGroups.join(", ")}' 필수 옵션에 고를 수 있는 항목이 없어 지금은 판매되지 않아요.
                      선택지를 추가하거나 그룹을 비활성화해 주세요.
                    </div>
                  )}
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
      {item.optionGroups.length === 0 && <p className="text-muted">옵션이 없어요. 아래에서 그룹을 추가하세요.</p>}
      {item.optionGroups.map((group) => (
        <OptionGroupEditor
          key={group.id}
          menuItemId={item.id}
          group={group}
          saving={saving}
          onCall={call}
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
  saving,
  onCall,
}: {
  menuItemId: string;
  group: OptionGroup;
  saving: boolean;
  onCall: (fn: () => Promise<unknown>) => Promise<void>;
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
        <input
          className="field"
          style={{ marginBottom: 0, width: 90 }}
          type="number"
          value={group.sortOrder}
          onChange={(e) => onCall(() => api.patch(base, { sortOrder: Number(e.target.value) || 0 }))}
          aria-label="그룹 정렬 순서"
        />
        <button className="btn-secondary" disabled={saving || name === group.name} onClick={() => onCall(() => api.patch(base, { name }))}>
          이름 저장
        </button>
        <button className="btn-danger-outline" disabled={saving} onClick={() => onCall(() => api.del(base))}>
          그룹 삭제
        </button>
      </div>

      {group.choices.length === 0 && <p className="error-text">선택지가 없어요. 필수 그룹이면 이 메뉴는 판매되지 않습니다.</p>}
      {group.choices.map((c) => {
        const choiceBase = `/api/staff/admin/menu/option-groups/${group.id}/choices/${c.id}`;
        return (
          <div key={c.id} className="admin-option-choice">
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
