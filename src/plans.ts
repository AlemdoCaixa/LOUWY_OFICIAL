import type { PlanDefinition, PlanId } from "./types";

export const PLANS: PlanDefinition[] = [
  { id: "free", name: "Grátis", priceCents: 0, memberLimit: 5 },
  { id: "members10", name: "Até 10 membros", priceCents: 1990, memberLimit: 10 },
  { id: "members25", name: "Até 25 membros", priceCents: 2990, memberLimit: 25 },
  { id: "unlimited", name: "Ilimitado", priceCents: 5990, memberLimit: null },
];

export function planById(id: PlanId | string | undefined) {
  return PLANS.find((plan) => plan.id === id) || PLANS[0];
}

export function formatPlanPrice(priceCents: number) {
  if (!priceCents) return "Grátis";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(priceCents / 100);
}

export function planMemberLabel(limit: number | null) {
  return limit === null ? "Membros ilimitados" : `Até ${limit} membros`;
}
