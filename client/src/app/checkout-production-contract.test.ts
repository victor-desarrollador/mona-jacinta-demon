import { describe, expect, it } from "vitest";
import {
  buildReservationRequest,
  buildConfirmationRequest,
} from "./checkout-quote";

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RESERVE_KEY = "33333333-3333-4333-8333-333333333333";
const OPERATION_KEY = "44444444-4444-4444-8444-444444444444";

const quote = {
  saleId: SALE_ID,
  saleNumber: "CEN-V-000001",
  pricingModel: "PROPORTIONAL_V1" as const,
  enabledMethods: [
    { method: "CASH" as const, available: true as const },
    { method: "TRANSFER" as const, available: true as const },
    { method: "CARD_DEBIT" as const, available: true as const },
    { method: "CARD_CREDIT" as const, available: true as const },
    { method: "QR" as const, available: true as const },
  ],
  fullPrices: {
    CASH: BigInt("4500000"),
    TRANSFER: BigInt("4750000"),
    CARD_DEBIT: BigInt("4812500"),
    CARD_CREDIT: BigInt("5175000"),
    QR: BigInt("5040000"),
  },
  tenders: [],
  balance: { method: "CASH" as const, amount: BigInt("4500000") },
  total: BigInt("4500000"),
  lines: [],
  unappliedCollections: [],
  reservationExpiresAt: null,
};

describe("Production checkout contract", () => {
  it("construye la reserva sin enviar evidencia de pago todavía", () => {
    const body = buildReservationRequest({
      saleId: SALE_ID,
      reserveKey: RESERVE_KEY,
      cashSessionId: SESSION_ID,
      draft: {
        balanceMethod: "CASH",
        fixed: [],
        receivedAmount: "5000000",
      },
      quote,
    });

    expect(body).toEqual({
      reserveKey: RESERVE_KEY,
      cashSessionId: SESSION_ID,
      balanceMethod: "CASH",
      expectedTotal: "4500000",
      expectedBalanceAmount: "4500000",
      tenders: [
        {
          method: "CASH",
          role: "BALANCE",
          source: "NEW",
        },
      ],
    });

    expect(JSON.stringify(body)).not.toContain("receivedAmount");
    expect(JSON.stringify(body)).not.toContain("reference");
  });

  it("construye la confirmación usando reserveKey + operationKey y solo evidencia", () => {
    const body = buildConfirmationRequest({
      reserveKey: RESERVE_KEY,
      operationKey: OPERATION_KEY,
      draft: {
        balanceMethod: "CASH",
        fixed: [],
        receivedAmount: "5000000",
      },
      reservedTenders: [
        {
          method: "CASH",
          role: "BALANCE",
          source: "NEW",
          amount: null,
          externalCollectionId: null,
        },
      ],
    });

    expect(body).toEqual({
      reserveKey: RESERVE_KEY,
      operationKey: OPERATION_KEY,
      tenders: [
        {
          method: "CASH",
          receivedAmount: "5000000",
        },
      ],
    });

    expect(body).not.toHaveProperty("cashSessionId");
    expect(body).not.toHaveProperty("expectedTotal");
    expect(body).not.toHaveProperty("balanceMethod");
  });
});
