import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ExchangeWorkspace from "./ExchangeWorkspace";
import { CodedApiError } from "../lib/api";
import { createExchangeDraftStoreForTests, exchangeDrafts } from "./exchange-draft-store";
import { makeLocks } from "./exchange-store-test-harness";

// Cambios de prenda, UI-4 — what a RELOAD brings back. The durable records are written by independent store instances ("the previous page
// load") BEFORE the process-wide store is first used, so it loads them exactly as a fresh page would. EW67, EW68.
//   - an UNCERTAIN attempt comes back UNCERTAIN, with no automatic request and no way to start a new exchange;
//   - a CONFIRMED tombstone comes back blocked until reconciled, with no automatic request.
// (A draft that was only being edited is not durable by design; its survival across an unmount is EW66 in exchange-workspace.test.tsx.)

const SALE_U = randomUUID();
const SALE_C = randomUUID();
const ITEM = randomUUID();
const VARIANT = randomUUID();
const EXCHANGE_C = randomUUID();
const WHO = { token: "tok", userId: "u1", branchIds: ["b1"], labels: [{ id: "b1", name: "Centro", code: "CE" }], onSessionExpired: () => {} };

async function previousPageLoad(saleId: string, request: () => Promise<unknown>) {
  const store = createExchangeDraftStoreForTests({ storage: window.localStorage, request, newKey: () => randomUUID(), locks: makeLocks() });
  store.openDraftUnsafe({
    userId: "u1", branchId: "b1", saleId, saleNumber: "T-OLD",
    lines: [{ saleItemId: ITEM, replacementVariantId: null, replacementLabel: "", returnQuantity: "", exchangedQuantityBefore: "0" }],
  });
  store.edit("u1", saleId, { type: "reason", value: "Talle" });
  store.edit("u1", saleId, { type: "line", saleItemId: ITEM, replacementVariantId: VARIANT, replacementLabel: "Buzo", returnQuantity: "1" });
  await store.send({ userId: "u1", saleId, token: "t" });
}

describe("ExchangeWorkspace UI-4 — restore after reload", () => {
  beforeAll(async () => {
    window.localStorage.clear();
    await previousPageLoad(SALE_U, async () => { throw new CodedApiError("boom", 500, "INTERNAL", null); });
    await previousPageLoad(SALE_C, async () => ({ exchangeId: EXCHANGE_C, replayed: false }));
    Object.defineProperty(navigator, "locks", { value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() }, configurable: true });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("EW67 an UNCERTAIN attempt reappears as UNCERTAIN, requests nothing by itself and cannot start another exchange", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ExchangeWorkspace {...WHO} />);
    expect(exchangeDrafts.getDraft("u1", SALE_U)!.attempt!.status).toBe("UNCERTAIN");
    const box = screen.getByTestId(`draft-${SALE_U}`);
    expect(box).toHaveTextContent("No pudimos confirmar si el cambio se registró");
    expect(within(box).getByRole("button", { name: /Verificar el cambio/ })).toBeEnabled();
    expect(within(box).queryByRole("button", { name: /Confirmar cambio/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("EW68 a CONFIRMED tombstone reappears blocked until reconciled, requests nothing by itself and offers no second send", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ExchangeWorkspace {...WHO} />);
    expect(exchangeDrafts.getDraft("u1", SALE_C)!.recovery).toEqual({ reason: "CONFIRMED" });
    const box = screen.getByTestId(`draft-${SALE_C}`);
    expect(box).toHaveTextContent("Cambio confirmado");
    expect(box).toHaveTextContent(EXCHANGE_C);
    expect(within(box).queryByRole("button", { name: /Confirmar cambio|Verificar el cambio/ })).toBeNull();
    expect(box).toHaveTextContent(/Buscá la venta/); // a reloaded tombstone does not know the sale number: it is refreshed by looking the sale up
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("F01-10-UI after a reload, searching the sale whose last remainder the CONFIRMED exchange spent recovers the tombstone (no editable draft); 'Actualizar venta' then closes it with its own GET", async () => {
    const body = {
      sale: { id: SALE_C, saleNumber: "T-C", branchId: "b1", status: "COMPLETED", pricingMode: "RETAIL", priceMode: "LIST", total: "1000" },
      exchangeable: true,
      lines: [{ saleItemId: ITEM, variantId: "v", productName: "Buzo", variantName: "M", sku: "SKU", quantity: "1", unitPrice: "1000", exchangedQuantity: "1", remainingQuantity: "0" }],
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<ExchangeWorkspace {...WHO} />);
    fireEvent.change(screen.getByLabelText(/Número de venta/), { target: { value: "T-C" } });
    fireEvent.click(screen.getByRole("button", { name: /Buscar venta/ }));
    await waitFor(() => expect(document.querySelector("[data-phase]")!.getAttribute("data-phase")).toBe("SALE_LOADED"));
    expect(fetchMock).toHaveBeenCalledTimes(1); // the search read is not the proof
    expect(exchangeDrafts.getDraft("u1", SALE_C)!.recovery).toEqual({ reason: "CONFIRMED" });
    expect(screen.queryByRole("button", { name: /Confirmar cambio/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Actualizar venta/ }));
    await waitFor(() => expect(exchangeDrafts.getDraft("u1", SALE_C)).toBeNull()); // reconciled and closed: nothing left, no draft
    expect(fetchMock).toHaveBeenCalledTimes(2); // reconcileAfterFreshRead's own GET
    expect(screen.queryByText(/no pudimos actualizar la venta/)).toBeNull();
  });
});
