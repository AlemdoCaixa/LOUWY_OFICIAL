import assert from "node:assert/strict";
import test from "node:test";
import { billingSummary, normalizeSubscription, PLAN_DEFINITIONS } from "./plans.mjs";

test("free plan includes the master and allows five active accounts", () => {
  const workspace = {
    members: Array.from({ length: 5 }, (_, index) => ({ id: String(index), active: true })),
    subscription: { planId: "free", status: "active" },
  };
  const summary = billingSummary(workspace);
  assert.equal(summary.members, 5);
  assert.equal(summary.memberLimit, 5);
  assert.equal(summary.canAddMembers, false);
  assert.equal(summary.remaining, 0);
});

test("paid tiers expose the requested limits and prices", () => {
  assert.deepEqual(
    Object.values(PLAN_DEFINITIONS).map(({ id, priceCents, memberLimit }) => ({ id, priceCents, memberLimit })),
    [
      { id: "free", priceCents: 0, memberLimit: 5 },
      { id: "members10", priceCents: 1990, memberLimit: 10 },
      { id: "members25", priceCents: 2990, memberLimit: 25 },
      { id: "unlimited", priceCents: 5990, memberLimit: null },
    ],
  );
});

test("unknown subscriptions fall back safely to free", () => {
  const subscription = normalizeSubscription({ planId: "not-a-plan", status: "strange" });
  assert.equal(subscription.planId, "free");
  assert.equal(subscription.status, "active");
  assert.equal(subscription.providerCustomerId, "");
});
