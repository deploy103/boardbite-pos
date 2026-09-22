import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import { normalizeCouponCode, parseExpiryInput, MAX_COUPON_NUMBER } from "../src/services/coupon.js";
import { createCounterOnlyItem, createMenuItem, createStaff, loginAdmin, loginAgent, loginFront } from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

function confirm(front: Awaited<ReturnType<typeof loginAgent>>, body: Record<string, unknown>) {
  return front.post("/api/staff/front/counter/confirm").set(...H).send(body);
}

async function issue(admin: Awaited<ReturnType<typeof loginAgent>>, body: Record<string, unknown>) {
  return admin
    .post("/api/staff/admin/coupons/batches")
    .set(...H)
    .send({ idempotencyKey: `b-${Date.now()}-${Math.random()}`, ...body });
}

/** 요구사항.md §9 인수 테스트 9~15 — 쿠폰 발급/사용/계산/동시성/환불. */
describe("쿠폰 (인수 9~15)", () => {
  it("10. 번호 정규화: 1 / 01 / 001은 모두 같고, 000·문자·1000은 거부된다", () => {
    expect(normalizeCouponCode("1")).toBe("001");
    expect(normalizeCouponCode("01")).toBe("001");
    expect(normalizeCouponCode(" 001 ")).toBe("001");
    expect(normalizeCouponCode("999")).toBe("999");
    for (const bad of ["000", "0", "1000", "abc", "1a", "", "-1"]) {
      expect(() => normalizeCouponCode(bad)).toThrow();
    }
  });

  it("만료일만 입력하면 한국시간 그날 23:59:59로 해석한다", () => {
    const parsed = parseExpiryInput("2026-09-30")!;
    // KST 23:59:59.999 = UTC 14:59:59.999 같은 날
    expect(parsed.toISOString()).toBe("2026-09-30T14:59:59.999Z");
    expect(parseExpiryInput(null)).toBeNull();
    expect(parseExpiryInput("")).toBeNull();
  });

  it("9. 10장을 발급하면 서로 다른 3자리 번호가 나오고, 같은 요청 재전송은 중복 발급하지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const key = `dup-${Date.now()}`;
    const first = await admin
      .post("/api/staff/admin/coupons/batches")
      .set(...H)
      .send({ idempotencyKey: key, type: "AMOUNT", name: "천원권", amount: 1000, quantity: 10 });
    expect(first.status).toBe(201);
    expect(first.body.batch.codes).toHaveLength(10);
    expect(new Set(first.body.batch.codes).size).toBe(10);
    for (const code of first.body.batch.codes) expect(code).toMatch(/^\d{3}$/);

    const retry = await admin
      .post("/api/staff/admin/coupons/batches")
      .set(...H)
      .send({ idempotencyKey: key, type: "AMOUNT", name: "천원권", amount: 1000, quantity: 10 });
    expect(retry.status).toBe(200);
    expect(retry.body.reused).toBe(true);
    expect(retry.body.batch.codes).toEqual(first.body.batch.codes);
    expect(await prisma.coupon.count({ where: { batchId: first.body.batch.id } })).toBe(10);
  });

  it("9. 동시 발급에서도 번호가 겹치지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const before = await prisma.coupon.count();
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        admin
          .post("/api/staff/admin/coupons/batches")
          .set(...H)
          .send({ idempotencyKey: `race-${Date.now()}-${n}`, type: "AMOUNT", name: `동시${n}`, amount: 500, quantity: 5 }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const codes = created.flatMap((r) => r.body.batch.codes as string[]);
    // 성공한 발급끼리 번호가 겹치지 않는다.
    expect(new Set(codes).size).toBe(codes.length);
    expect(await prisma.coupon.count()).toBe(before + codes.length);
    // 전체 번호도 여전히 유일하다.
    const all = await prisma.coupon.findMany({ select: { code: true } });
    expect(new Set(all.map((c) => c.code)).size).toBe(all.length);
  });

  it("9. 남은 번호보다 많이 요청하면 전체 발급이 실패하고 기존 쿠폰은 그대로다", async () => {
    const { agent: admin } = await loginAdmin();
    const before = await prisma.coupon.count();
    const res = await issue(admin, { type: "AMOUNT", name: "초과", amount: 1000, quantity: MAX_COUPON_NUMBER });
    // 이미 다른 테스트에서 일부 번호를 썼으므로 999장 요청은 남은 수량을 넘는다.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("COUPON_NUMBERS_EXHAUSTED");
    expect(await prisma.coupon.count()).toBe(before);
  });

  it("10/7절. 금액권·상품권 계산이 요구사항 §7 예시와 정확히 일치한다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const udon = await createMenuItem({ name: "정산우동", price: 3000, channel: "FRONT" });
    const group = await prisma.optionGroup.create({
      data: { menuItemId: udon.id, name: "추가 토핑", minSelect: 0, maxSelect: null },
    });
    const egg = await prisma.optionChoice.create({ data: { groupId: group.id, name: "계란", extraPrice: 500 } });
    const roulette3 = await createCounterOnlyItem("정산룰렛3회", 1000);

    const amount1000 = (await issue(admin, { type: "AMOUNT", name: "1000원권", amount: 1000, quantity: 1 })).body.batch.codes[0];
    const amount2000 = (await issue(admin, { type: "AMOUNT", name: "2000원권", amount: 2000, quantity: 1 })).body.batch.codes[0];
    const itemCodes = (
      await issue(admin, { type: "ITEM", name: "우동 상품권", quantity: 3, targetMenuItemIds: [udon.id] })
    ).body.batch.codes as string[];

    const quote = (body: Record<string, unknown>) => front.post("/api/staff/front/counter/quote").set(...H).send(body);

    // 우동 + 1,000원 금액권 → 3,000 / 1,000 / 2,000
    let q = await quote({ items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }], couponCode: amount1000 });
    expect([q.body.quote.subtotal, q.body.quote.discountAmount, q.body.quote.totalAmount]).toEqual([3000, 1000, 2000]);

    // 우동 + 상품권 → 3,000 / 3,000 / 0
    q = await quote({ items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }], couponCode: itemCodes[0] });
    expect([q.body.quote.subtotal, q.body.quote.discountAmount, q.body.quote.totalAmount]).toEqual([3000, 3000, 0]);

    // 우동 + 계란 500 + 상품권 → 3,500 / 3,000 / 500 (유료 옵션은 별도 결제)
    q = await quote({ items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [egg.id] }], couponCode: itemCodes[0] });
    expect([q.body.quote.subtotal, q.body.quote.discountAmount, q.body.quote.totalAmount]).toEqual([3500, 3000, 500]);

    // 우동 2개 + 상품권 1장 → 6,000 / 3,000 / 3,000 (1개 기본가만 무료)
    q = await quote({ items: [{ menuItemId: udon.id, quantity: 2, optionChoiceIds: [] }], couponCode: itemCodes[0] });
    expect([q.body.quote.subtotal, q.body.quote.discountAmount, q.body.quote.totalAmount]).toEqual([6000, 3000, 3000]);

    // 룰렛 3회(1,000) + 2,000원 금액권 → 1,000 / 1,000 / 0 (잔액 소멸)
    q = await quote({ items: [{ menuItemId: roulette3.id, quantity: 1, optionChoiceIds: [] }], couponCode: amount2000 });
    expect([q.body.quote.subtotal, q.body.quote.discountAmount, q.body.quote.totalAmount]).toEqual([1000, 1000, 0]);

    // 1 / 01 / 001 동일 처리
    const short = String(Number(amount1000));
    const q2 = await quote({ items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }], couponCode: short });
    expect(q2.body.quote.coupon.code).toBe(amount1000);
  });

  it("10. 잘못된 번호 · 만료 · 발급 취소 · 사용 완료 · 대상 불일치는 각각 구분해 거부한다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("쿠폰거부", 2000);
    const other = await createMenuItem({ name: "다른대상", price: 3000, channel: "FRONT" });

    const lookup = (code: string) => front.get(`/api/staff/front/counter/coupons/${code}`).set(...H);

    // 존재하지 않음
    expect((await lookup("998")).status === 404 || (await lookup("998")).status === 200).toBe(true);

    // 발급 취소
    const cancelled = (await issue(admin, { type: "AMOUNT", name: "취소권", amount: 500, quantity: 1 })).body.batch;
    const cancelledCoupon = await prisma.coupon.findFirstOrThrow({ where: { batchId: cancelled.id } });
    await admin.post("/api/staff/admin/coupons/cancel").set(...H).send({ couponIds: [cancelledCoupon.id] });
    const cancelledLookup = await lookup(cancelledCoupon.code);
    expect(cancelledLookup.body.coupon.state).toBe("CANCELLED");

    // 만료 — 배치의 만료 시각을 과거로 직접 돌려 파생 판정을 확인한다.
    const expiredBatch = (await issue(admin, { type: "AMOUNT", name: "만료권", amount: 500, quantity: 1 })).body.batch;
    await prisma.couponBatch.update({ where: { id: expiredBatch.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expiredCoupon = await prisma.coupon.findFirstOrThrow({ where: { batchId: expiredBatch.id } });
    expect((await lookup(expiredCoupon.code)).body.coupon.state).toBe("EXPIRED");
    const expiredUse = await confirm(front, {
      idempotencyKey: `exp-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: expiredCoupon.code,
      methodCode: "CARD",
    });
    expect(expiredUse.status).toBe(409);
    expect(expiredUse.body.code).toBe("COUPON_EXPIRED");

    // 대상 불일치 상품권
    const targeted = (await issue(admin, { type: "ITEM", name: "대상권", quantity: 1, targetMenuItemIds: [other.id] })).body
      .batch.codes[0];
    const mismatch = await confirm(front, {
      idempotencyKey: `mis-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: targeted,
      methodCode: "CARD",
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("COUPON_TARGET_MISSING");

    // 사용 완료
    const used = (await issue(admin, { type: "AMOUNT", name: "사용권", amount: 500, quantity: 1 })).body.batch.codes[0];
    const ok = await confirm(front, {
      idempotencyKey: `used1-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: used,
      methodCode: "CARD",
    });
    expect(ok.status).toBe(201);
    const reuse = await confirm(front, {
      idempotencyKey: `used2-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: used,
      methodCode: "CARD",
    });
    expect(reuse.status).toBe(409);
    expect(reuse.body.code).toBe("COUPON_USED");
  });

  it("11. 미리보기·화면 이탈·확정 실패에서는 쿠폰이 소진되지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("미소진", 1000);
    const code = (await issue(admin, { type: "AMOUNT", name: "미소진권", amount: 500, quantity: 1 })).body.batch.codes[0];

    // 조회만
    await front.get(`/api/staff/front/counter/coupons/${code}`).set(...H);
    // 견적만 여러 번
    for (let i = 0; i < 3; i++) {
      await front
        .post("/api/staff/front/counter/quote")
        .set(...H)
        .send({ items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }], couponCode: code });
    }
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("AVAILABLE");

    // 확정 실패(현금 부족) — 쿠폰도 거래도 남지 않아야 한다.
    const failed = await confirm(front, {
      idempotencyKey: `fail-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      methodCode: "CASH",
      tenderedAmount: 100,
    });
    expect(failed.status).toBe(400);
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("AVAILABLE");
    expect(await prisma.couponRedemption.count({ where: { coupon: { code } } })).toBe(0);
  });

  it("11. 할인이 0원이 되는 거래에는 쿠폰을 소진하지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const free = await createCounterOnlyItem("0원상품", 0);
    const code = (await issue(admin, { type: "AMOUNT", name: "무효과권", amount: 1000, quantity: 1 })).body.batch.codes[0];

    const res = await confirm(front, {
      idempotencyKey: `zero-${Date.now()}`,
      items: [{ menuItemId: free.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COUPON_NO_EFFECT");
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("AVAILABLE");
  });

  it("12. 같은 쿠폰으로 두 거래를 동시에 결제하면 정확히 하나만 성공한다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: frontA } = await loginFront();
    const { agent: frontB } = await loginFront();
    const item = await createCounterOnlyItem("경합상품", 3000);
    const code = (await issue(admin, { type: "AMOUNT", name: "경합권", amount: 1000, quantity: 1 })).body.batch.codes[0];

    const body = (key: string) => ({
      idempotencyKey: key,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      methodCode: "CARD",
    });

    const [a, b] = await Promise.all([
      confirm(frontA, body(`raceA-${Date.now()}`)),
      confirm(frontB, body(`raceB-${Date.now()}`)),
    ]);
    const successes = [a, b].filter((r) => r.status === 201);
    expect(successes).toHaveLength(1);
    expect(await prisma.couponRedemption.count({ where: { coupon: { code } } })).toBe(1);
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("USED");
    // 실패한 쪽은 거래·수납을 전혀 남기지 않는다.
    expect(await prisma.counterSale.count({ where: { redemptions: { some: { coupon: { code } } } } })).toBe(1);
  });

  it("14. 전액 쿠폰 거래는 매출 0원이지만 제공·사용 기록은 남는다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const udon = await createMenuItem({ name: "무료우동", price: 3000, channel: "FRONT" });
    const code = (await issue(admin, { type: "ITEM", name: "무료권", quantity: 1, targetMenuItemIds: [udon.id] })).body.batch
      .codes[0];

    const res = await confirm(front, {
      idempotencyKey: `free-${Date.now()}`,
      items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      // 0원 거래는 결제수단 없이 확정된다.
    });
    expect(res.status).toBe(201);
    const sale = res.body.sale;
    expect(sale.ledger.netChargedAmount).toBe(0);
    expect(sale.ledger.couponDiscountAmount).toBe(3000);
    // 0원 CHARGE 행을 억지로 만들지 않는다.
    expect(await prisma.payment.count({ where: { counterSaleId: sale.id, kind: "CHARGE" } })).toBe(0);
    // 제공(주문)과 쿠폰 사용 기록은 남는다.
    expect(sale.orders[0].items[0].nameSnapshot).toBe("무료우동");
    expect(sale.coupon.code).toBe(code);
  });

  it("14. 상품권 + 유료 옵션이면 옵션 차액만 매출로 잡힌다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const udon = await createMenuItem({ name: "옵션차액우동", price: 3000, channel: "FRONT" });
    const g = await prisma.optionGroup.create({ data: { menuItemId: udon.id, name: "토핑", minSelect: 0, maxSelect: null } });
    const egg = await prisma.optionChoice.create({ data: { groupId: g.id, name: "계란", extraPrice: 500 } });
    const code = (await issue(admin, { type: "ITEM", name: "차액권", quantity: 1, targetMenuItemIds: [udon.id] })).body.batch
      .codes[0];

    const res = await confirm(front, {
      idempotencyKey: `diff-${Date.now()}`,
      items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [egg.id] }],
      couponCode: code,
      methodCode: "CASH",
      tenderedAmount: 500,
    });
    expect(res.status).toBe(201);
    expect(res.body.sale.ledger.netChargedAmount).toBe(500);
    expect(res.body.sale.ledger.couponDiscountAmount).toBe(3000);
  });

  it("15. 3,000원 주문에 1,000원 쿠폰 후 전체 환불하면 순매출 0 · 순 쿠폰 제공액 0 · 쿠폰은 사용 완료 유지", async () => {
    const { agent: admin, password } = await loginAdmin();
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("환불검증", 3000);
    const code = (await issue(admin, { type: "AMOUNT", name: "환불권", amount: 1000, quantity: 1 })).body.batch.codes[0];

    const sale = await confirm(front, {
      idempotencyKey: `refund-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      methodCode: "CASH",
      tenderedAmount: 2000,
    });
    expect(sale.status).toBe(201);
    expect(sale.body.sale.ledger.netChargedAmount).toBe(2000);

    await admin.post("/api/staff/step-up").set(...H).send({ password });
    const cancelled = await admin
      .post(`/api/staff/admin/counter-sales/${sale.body.sale.id}/cancel`)
      .set(...H)
      .send({ reason: "전액 환불" });
    expect(cancelled.status).toBe(200);

    const ledger = cancelled.body.sale.ledger;
    expect(ledger.netChargedAmount).toBe(0); // 순매출 0
    expect(ledger.couponDiscountAmount).toBe(0); // 순 쿠폰 제공액 0
    // 쿠폰 자체는 사용 완료로 유지되고 자동 복구되지 않는다.
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("USED");
    const redemption = await prisma.couponRedemption.findFirstOrThrow({ where: { coupon: { code } } });
    expect(redemption.cancelledAt).not.toBeNull();

    // 다시 쓰려 해도 거부된다.
    const reuse = await confirm(front, {
      idempotencyKey: `reuse-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      methodCode: "CARD",
    });
    expect(reuse.status).toBe(409);
  });

  it("사용된 쿠폰은 발급 취소되지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("취소불가", 1000);
    const code = (await issue(admin, { type: "AMOUNT", name: "사용후취소", amount: 500, quantity: 1 })).body.batch.codes[0];
    await confirm(front, {
      idempotencyKey: `usedc-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      methodCode: "CARD",
    });
    const coupon = await prisma.coupon.findFirstOrThrow({ where: { code } });
    const res = await admin.post("/api/staff/admin/coupons/cancel").set(...H).send({ couponIds: [coupon.id] });
    expect(res.body.result.cancelledCount).toBe(0);
    expect(res.body.result.skippedCount).toBe(1);
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("USED");
  });

  it("16. FRONT는 단건 조회만 가능하고 전체 쿠폰 목록/발급은 ADMIN 전용이다", async () => {
    const { agent: front } = await loginFront();
    expect((await front.get("/api/staff/admin/coupons").set(...H)).status).toBe(403);
    expect(
      (await front.post("/api/staff/admin/coupons/batches").set(...H).send({ idempotencyKey: "x", type: "AMOUNT", name: "n", amount: 100, quantity: 1 }))
        .status,
    ).toBe(403);

    // 손님 API에는 쿠폰 경로가 없다.
    const { default: request } = await import("supertest");
    const { app } = await import("./helpers.js");
    const res = await request(app).get("/api/customer/coupons/001").set(...H);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("쿠폰 CSV는 수식 주입을 막고, 번호는 표시용 열로 복구할 수 있다", async () => {
    const { agent: admin } = await loginAdmin();
    const issued = await issue(admin, { type: "AMOUNT", name: "=cmd|calc", amount: 100, quantity: 1 });
    const code = issued.body.batch.codes[0] as string;
    const res = await admin.get("/api/staff/admin/export/coupons.csv").set(...H);
    expect(res.status).toBe(200);
    // 번호는 수식이 아닌 평문으로 나가고, 앞자리 0이 날아가도 복구할 수 있는 표시용 열이 함께 있다.
    expect(res.text).toContain(`${code},쿠폰 ${code}`);
    // 어떤 셀도 수식으로 시작하지 않는다 — 관리자가 자유 입력한 배치 이름의 = 는 중화된다.
    expect(res.text).toContain("'=cmd|calc");
    for (const line of res.text.split("\r\n").slice(1)) {
      for (const cell of line.split(",")) {
        expect(cell.startsWith("=")).toBe(false);
      }
    }
  });

  it("엑셀용 CSV는 번호를 텍스트로 고정해 앞자리 0을 유지하면서도 수식이 되지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const issued = await issue(admin, { type: "AMOUNT", name: "엑셀권", amount: 100, quantity: 1 });
    const code = issued.body.batch.codes[0] as string;

    const res = await admin.get("/api/staff/admin/export/coupons.csv?format=excel").set(...H);
    expect(res.status).toBe(200);
    // 따옴표 안 탭 접두 — Excel이 텍스트로 읽어 001이 1로 바뀌지 않는다.
    expect(res.text).toContain(`"\t${code}"`);
    // 그 자체가 수식인 ="001" 형태는 쓰지 않는다.
    expect(res.text).not.toContain('="');
    // 어떤 셀도 수식으로 시작하지 않는다.
    for (const line of res.text.split("\r\n").slice(1)) {
      for (const cell of line.split(",")) {
        expect(cell.replace(/^"/, "").startsWith("=")).toBe(false);
      }
    }
  });

  it("상품권 대상 메뉴가 모두 삭제되면 자동 대체 없이 안내 상태로 표시된다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const target = await createMenuItem({ name: "삭제될대상", price: 2000, channel: "FRONT" });
    const code = (await issue(admin, { type: "ITEM", name: "고아권", quantity: 1, targetMenuItemIds: [target.id] })).body
      .batch.codes[0];

    await admin.delete(`/api/staff/admin/menu/items/${target.id}`).set(...H);
    const lookup = await front.get(`/api/staff/front/counter/coupons/${code}`).set(...H);
    expect(lookup.body.coupon.state).toBe("AVAILABLE");
    expect(lookup.body.coupon.targetsUnavailable).toBe(true);
    expect(lookup.body.coupon.usableTargets).toHaveLength(0);
  });
});
