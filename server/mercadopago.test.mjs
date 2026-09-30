import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  approvedAuthorizedPayment,
  buildLouwyReference,
  mercadoPagoSubscriptionStatus,
  parseLouwyReference,
  validBillingEmail,
  verifyMercadoPagoSignature,
} from "./mercadopago.mjs";

test("Mercado Pago reference keeps church and monthly plan", () => {
  const reference = buildLouwyReference("church-123", "members25");
  assert.equal(reference, "louwy:church-123:members25");
  assert.deepEqual(parseLouwyReference(reference), { churchId: "church-123", planId: "members25" });
  assert.deepEqual(parseLouwyReference("invalid"), { churchId: "", planId: "" });
});

test("Mercado Pago webhook signature is verified", () => {
  const secret = "test-secret";
  const dataId = "ABC123";
  const requestId = "request-9";
  const ts = "1790612345";
  const message = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac("sha256", secret).update(message).digest("hex");
  assert.equal(verifyMercadoPagoSignature({
    secret,
    signature: `ts=${ts},v1=${v1}`,
    requestId,
    dataId,
  }), true);
  assert.equal(verifyMercadoPagoSignature({
    secret,
    signature: `ts=${ts},v1=${"0".repeat(64)}`,
    requestId,
    dataId,
  }), false);
});

test("Mercado Pago statuses map to Louwy billing states", () => {
  assert.equal(mercadoPagoSubscriptionStatus("authorized"), "active");
  assert.equal(mercadoPagoSubscriptionStatus("pending"), "pending");
  assert.equal(mercadoPagoSubscriptionStatus("paused"), "past_due");
  assert.equal(mercadoPagoSubscriptionStatus("cancelled"), "cancelled");
  assert.equal(approvedAuthorizedPayment("processed"), true);
  assert.equal(approvedAuthorizedPayment("rejected"), false);
});

test("billing email is normalized and validated", () => {
  assert.equal(validBillingEmail(" Financeiro@Igreja.COM "), "financeiro@igreja.com");
  assert.equal(validBillingEmail("sem-email"), "");
});
