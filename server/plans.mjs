export const PLAN_DEFINITIONS = Object.freeze({
  free: Object.freeze({ id: "free", name: "Grátis", priceCents: 0, memberLimit: 5 }),
  members10: Object.freeze({ id: "members10", name: "Até 10 membros", priceCents: 1990, memberLimit: 10 }),
  members25: Object.freeze({ id: "members25", name: "Até 25 membros", priceCents: 2990, memberLimit: 25 }),
  unlimited: Object.freeze({ id: "unlimited", name: "Ilimitado", priceCents: 5990, memberLimit: null }),
});

export const PLAN_IDS = Object.freeze(Object.keys(PLAN_DEFINITIONS));

export function normalizePlanId(value) {
  const id = String(value || "free");
  return PLAN_DEFINITIONS[id] ? id : "free";
}

export function normalizeSubscription(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    planId: normalizePlanId(source.planId),
    status: ["active", "pending", "past_due", "cancelled"].includes(source.status) ? source.status : "active",
    requestedPlanId: source.requestedPlanId && PLAN_DEFINITIONS[source.requestedPlanId] ? source.requestedPlanId : "",
    requestedAt: source.requestedAt ? String(source.requestedAt) : "",
    startedAt: source.startedAt ? String(source.startedAt) : "",
    updatedAt: source.updatedAt ? String(source.updatedAt) : "",
    provider: source.provider ? String(source.provider) : "",
    payerEmail: source.payerEmail ? String(source.payerEmail).toLowerCase() : "",
    providerCustomerId: source.providerCustomerId ? String(source.providerCustomerId) : "",
    providerSubscriptionId: source.providerSubscriptionId ? String(source.providerSubscriptionId) : "",
    requestedProviderSubscriptionId: source.requestedProviderSubscriptionId ? String(source.requestedProviderSubscriptionId) : "",
    nextPaymentAt: source.nextPaymentAt ? String(source.nextPaymentAt) : "",
    lastPaymentAt: source.lastPaymentAt ? String(source.lastPaymentAt) : "",
    cancelledAt: source.cancelledAt ? String(source.cancelledAt) : "",
  };
}

export function activeMemberCount(workspace) {
  return Array.isArray(workspace?.members)
    ? workspace.members.filter((member) => member?.active !== false).length
    : 0;
}

export function billingSummary(workspace) {
  const subscription = normalizeSubscription(workspace?.subscription);
  const plan = PLAN_DEFINITIONS[subscription.planId];
  const members = activeMemberCount(workspace);
  const memberLimit = plan.memberLimit;
  const remaining = memberLimit === null ? null : Math.max(0, memberLimit - members);
  return {
    subscription,
    plan,
    members,
    memberLimit,
    remaining,
    canAddMembers: memberLimit === null || members < memberLimit,
    overLimit: memberLimit !== null && members > memberLimit,
  };
}

export function publicPlans() {
  return PLAN_IDS.map((id) => PLAN_DEFINITIONS[id]);
}
