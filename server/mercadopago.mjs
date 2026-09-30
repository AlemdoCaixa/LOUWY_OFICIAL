import { createHmac, timingSafeEqual } from "node:crypto";

const API_ROOT = "https://api.mercadopago.com";

export function validBillingEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export function buildLouwyReference(churchId, planId) {
  return `louwy:${String(churchId)}:${String(planId)}`;
}

export function parseLouwyReference(value) {
  const match = String(value || "").match(/^louwy:([^:]+):(free|members10|members25|unlimited)$/);
  return match ? { churchId: match[1], planId: match[2] } : { churchId: "", planId: "" };
}

export function mercadoPagoSubscriptionStatus(value) {
  if (value === "authorized") return "active";
  if (value === "pending") return "pending";
  if (value === "paused") return "past_due";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "pending";
}
export async function mercadoPagoRequest(accessToken, path, { method = "GET", body } = {}) {
  const token = String(accessToken || "").trim();
  if (!token) throw Object.assign(new Error("Mercado Pago não configurado."), { status: 503 });
  const response = await fetch(API_ROOT + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const causes = Array.isArray(payload?.cause)
      ? payload.cause.map((item) => item?.description || item?.code).filter(Boolean).join("; ")
      : "";
    const detail = payload?.message || payload?.error || "Falha na comunicação com o Mercado Pago.";
    throw Object.assign(new Error(`${detail}${causes ? ` — ${causes}` : ""}`), {
      status: response.status,
      payload,
    });
  }
  return payload;
}
export function verifyMercadoPagoSignature({ secret, signature, requestId, dataId }) {
  const key = String(secret || "").trim();
  const id = String(dataId || "").toLowerCase();
  if (!key || !id || !signature || !requestId) return false;
  const parts = Object.fromEntries(
    String(signature).split(",").map((part) => part.trim().split("=")).filter((row) => row.length === 2),
  );
  if (!parts.ts || !parts.v1) return false;
  const message = `id:${id};request-id:${requestId};ts:${parts.ts};`;
  const expected = createHmac("sha256", key).update(message).digest("hex");
  const received = String(parts.v1).toLowerCase();
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function approvedAuthorizedPayment(value) {
  return ["processed", "approved", "authorized"].includes(String(value || "").toLowerCase());
}
