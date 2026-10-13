import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationsPage from "./page";

// M1: malformed GET /sales/pending and GET /sales/:id/payments answers are
// rejected before they reach React state (fail-closed), without confusing
// them with network/HTTP failures. M2: closing the register is a two-step
// confirmation; only the second step calls POST /close (CASH-1 unchanged).

const TOKEN_KEY = "mona-jacinta-token";

type Reply = { status: number; body: unknown } | { network: true };

type State = {
  user: { id: string; name: string; email: string; roles: string[]; branchIds: string[]; permissions: string[] };
  queue: () => Reply | Promise<Reply>;
  payments: (saleId: string) => Reply | Promise<Reply>;
  paymentPost?: () => Reply | Promise<Reply>;
  session: (branchId: string) => unknown;
  close?: () => Reply | Promise<Reply>;
  history?: unknown;
  calls: Array<{ url: string; method: string; body?: string }>;
};

const CLOSE = ["sale.charge", "cash.session.open", "cash.session.close"];
const cashier = (branchIds = ["CEN"]) => ({
  id: "c1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds, permissions: CLOSE,
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    saleId: "sale-1", saleNumber: "CEN-V-000001", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [{ id: "it-1", variantId: "v-1", productName: "Remera", variantName: "Negro / M", sku: "REM-1", quantity: "1", unitPrice: "1000000", subtotal: "1000000" }],
    subtotal: "1000000", total: "1000000", paidAmount: "0", remainingBalance: "1000000",
    holdState: "VALID", canAcceptPayment: true, paymentCount: 0, canCorrect: false, canCancel: false,
    pricingMode: "LIST", priceMode: "LIST", wholesaleConfirmed: false, canConfirmWholesale: false,
    ...overrides,
  };
}

function payment(saleId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `pay-${saleId}`, saleId, method: "TRANSFER", amount: "400000", receivedAmount: null, changeAmount: null,
    cashSessionId: null, idempotencyKey: `key-${saleId}`, paidAt: "2030-01-01T00:00:00.000Z", ...overrides,
  };
}

function openSession(branchId: string, sessionId = `cs-${branchId}`) {
  return {
    sessionId, registerId: `reg-${branchId}`, branchId, openedById: "c1", closedById: null,
    startingCash: "0", status: "OPEN", openedAt: "2030-01-02T09:00:00.000Z", closedAt: null,
  };
}

const ok = (body: unknown): Reply => ({ status: 200, body });

function json(reply: Reply): Response {
  if ("network" in reply) throw new TypeError("Failed to fetch");
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
}

function router(state: State) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    state.calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    const branchOf = () => new URL(url, "http://x").searchParams.get("branchId") ?? "";
    if (url.includes("/auth/me")) return json(ok({ user: state.user }));
    if (url.includes("/sales/pending")) return json(await state.queue());
    if (url.includes("/payments") && method === "POST") {
      return json(state.paymentPost ? await state.paymentPost() : { status: 201, body: payment("sale-1") });
    }
    if (url.includes("/payments")) return json(await state.payments(url.split("/sales/")[1].split("/")[0]));
    if (url.includes("/cash/sessions/") && url.endsWith("/close") && method === "POST") {
      if (state.close) return json(await state.close());
      const sessionId = url.split("/cash/sessions/")[1].replace("/close", "");
      return json(ok({
        ...openSession("CEN", sessionId), status: "CLOSED", closedById: "c1", closedAt: "2030-01-02T18:00:00.000Z",
        closingCash: "200000", expectedCash: "200000", countedCash: "200000", difference: "0",
      }));
    }
    if (url.includes("/cash/sessions?")) return json(ok(state.history ?? []));
    if (url.includes("/cash/current")) return json(ok(state.session(branchOf())));
    if (url.includes("/cash/register")) {
      const branchId = branchOf();
      return json(ok({ id: `reg-${branchId}`, branchId, name: branchId === "DEP" ? "Caja depósito" : "Caja principal" }));
    }
    return json(ok({ items: [] }));
  });
}

async function renderPage(partial: Partial<State> = {}) {
  const state: State = {
    user: cashier(),
    queue: () => ok({ items: [row()] }),
    payments: () => ok({ items: [] }),
    session: (branchId) => openSession(branchId),
    calls: [],
    ...partial,
  };
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", router(state));
  const view = render(<OperationsPage />);
  expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
  return { state, view };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const QUEUE_INVALID = "No se pudo validar la cola de ventas.";
const PAYMENTS_INVALID = "No se pudieron validar los pagos.";
const errorBanner = (container: HTMLElement) => container.querySelector(".error-banner");
const closePosts = (state: State) => state.calls.filter((call) => call.method === "POST" && call.url.endsWith("/close"));
const refreshButton = () => screen.getByRole("button", { name: "Actualizar" });

describe("M1 malformed /sales/pending answers fail closed", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const malformed: Array<[string, unknown]> = [
    ["A01 an empty object", {}],
    ["A02 items: null", { items: null }],
    ["A03 a non-integer total", { items: [row({ total: "12.5" })] }],
    ["A04 items that are not an array", { items: [row({ items: "x" })] }],
    ["A05 an item without quantity", { items: [row({ items: [{ ...row().items[0], quantity: undefined }] })] }],
    ["A06 an unknown price mode", { items: [row({ priceMode: "CRYPTO" })] }],
    ["A07 a top-level array", [row()]],
    ["A17 a row without canAcceptPayment", { items: [row({ canAcceptPayment: undefined })] }],
    ["A18 a row without priceMode", { items: [row({ priceMode: undefined })] }],
    ["A19 a DRAFT row", { items: [row({ status: "DRAFT" })] }],
    ["A20 an item with a zero quantity", { items: [row({ items: [{ ...row().items[0], quantity: "0" }] })] }],
    ["A21 an empty sale id", { items: [row({ saleId: "" })] }],
  ];

  for (const [name, body] of malformed) {
    it(`${name} never crashes, never shows an empty queue and reports the invalid answer`, async () => {
      await renderPage({ queue: () => ok(body) });
      expect(await screen.findByText(QUEUE_INVALID)).toBeInTheDocument();
      expect(screen.queryByText("Sin ventas pendientes")).toBeNull();
      expect(screen.queryByRole("heading", { name: "CEN-V-000001" })).toBeNull();
    });
  }

  it("A16 a 200 answer whose body is not JSON is treated as invalid", async () => {
    window.localStorage.setItem(TOKEN_KEY, "test-token");
    const state: State = {
      user: cashier(), queue: () => ok({ items: [] }), payments: () => ok({ items: [] }),
      session: (branchId) => openSession(branchId), calls: [],
    };
    const base = router(state);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sales/pending")) {
        return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response;
      }
      return base(input, init);
    }));
    render(<OperationsPage />);
    expect(await screen.findByText(QUEUE_INVALID)).toBeInTheDocument();
    expect(screen.queryByText("Sin ventas pendientes")).toBeNull();
  });

  it("A08 a malformed refresh hides the previous rows, and a valid refresh recovers them", async () => {
    let reply: Reply = ok({ items: [row()] });
    await renderPage({ queue: () => reply });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    reply = ok({ items: [row({ remainingBalance: "abc" })] });
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    fireEvent.click(refreshButton());
    expect(await screen.findByText(QUEUE_INVALID)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "CEN-V-000001" })).toBeNull();
    reply = ok({ items: [row()] });
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    fireEvent.click(refreshButton());
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    expect(screen.queryByText(QUEUE_INVALID)).toBeNull();
  });

  it("A09 a network failure keeps the last valid queue and is not reported as an invalid answer", async () => {
    let reply: Reply = ok({ items: [row()] });
    const { view } = await renderPage({ queue: () => reply });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    reply = { network: true };
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    fireEvent.click(refreshButton());
    await waitFor(() => expect(errorBanner(view.container)?.textContent).toBe("Failed to fetch"));
    expect(screen.getByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    expect(screen.queryByText(QUEUE_INVALID)).toBeNull();
  });

  it("A10 an HTTP 500 shows the server message, not an invalid-answer message", async () => {
    const { view } = await renderPage({ queue: () => ({ status: 500, body: { error: { message: "Cola no disponible" } } }) });
    await waitFor(() => expect(errorBanner(view.container)?.textContent).toBe("Cola no disponible"));
    expect(screen.queryByText(QUEUE_INVALID)).toBeNull();
  });
});

describe("M1 malformed payment answers fail closed", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const malformed: Array<[string, unknown]> = [
    ["A11 an empty object", {}],
    ["A12 a non-numeric amount", { items: [payment("sale-1", { amount: "abc" })] }],
    ["A13 a payment of another sale", { items: [payment("sale-9")] }],
    ["A26a a payment with an empty idempotency key", { items: [payment("sale-1", { idempotencyKey: "" })] }],
    ["A26b a payment without paidAt", { items: [payment("sale-1", { paidAt: undefined })] }],
  ];

  for (const [name, body] of malformed) {
    it(`${name} never crashes and is never shown as "no payments"`, async () => {
      await renderPage({ payments: () => ok(body) });
      expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
      expect(await screen.findByText(PAYMENTS_INVALID)).toBeInTheDocument();
      expect(screen.queryByText("Todavía no hay pagos registrados.")).toBeNull();
      expect(screen.queryByText("key-sale-9")).toBeNull();
    });
  }

  it("A14 a late payments answer of the previously selected sale never shows under the new one", async () => {
    const first = deferred<Reply>();
    await renderPage({
      queue: () => ok({ items: [row(), row({ saleId: "sale-2", saleNumber: "CEN-V-000002" })] }),
      payments: (saleId) => (saleId === "sale-1" ? first.promise : ok({ items: [] })),
    });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /CEN-V-000002/ }));
    expect(await screen.findByRole("heading", { name: "CEN-V-000002" })).toBeInTheDocument();
    expect(await screen.findByText("Todavía no hay pagos registrados.")).toBeInTheDocument();
    first.resolve(ok({ items: [payment("sale-1")] }));
    await settle();
    await settle();
    expect(screen.queryByText("key-sale-1")).toBeNull();
    expect(screen.getByText("Todavía no hay pagos registrados.")).toBeInTheDocument();
  });

  it("A15 a committed payment followed by a malformed queue is not offered as a retry", async () => {
    let queueReply: Reply = ok({ items: [row()] });
    const { state } = await renderPage({ queue: () => queueReply });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    state.payments = () => ok({ items: [payment("sale-1", { amount: "1000000" })] });
    queueReply = ok({ items: {} });
    const pay = screen.getByRole("button", { name: /Registrar pago/ });
    await waitFor(() => expect(pay).toBeEnabled());
    fireEvent.click(pay);
    expect(await screen.findByText(/Transferencia .* registrado\./)).toBeInTheDocument();
    expect(await screen.findByText(QUEUE_INVALID)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar mismo pago" })).toBeNull();
  });
});

describe("M2 two-step register close", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const closingInput = () => screen.getByRole("textbox", { name: /Cierre ARS/ });
  async function askToClose(amount = "2000") {
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled());
    fireEvent.change(closingInput(), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
  }
  const confirmButton = () => screen.queryByRole("button", { name: "Confirmar cierre" });

  it("B01 the first click never calls the close endpoint and shows branch, register and amount", async () => {
    const { state } = await renderPage({ queue: () => ok({ items: [] }) });
    await askToClose();
    expect(confirmButton()).toBeInTheDocument();
    const panel = screen.getByRole("group", { name: "Confirmar cierre de caja" });
    expect(panel).toHaveTextContent("Sucursal CEN");
    expect(panel).toHaveTextContent("Caja principal");
    expect(panel).toHaveTextContent(/Monto contado\s*\$\s*2\.000/);
    await settle();
    expect(closePosts(state)).toHaveLength(0);
  });

  it("B02 cancelling the confirmation has no side effect and the close can be asked again", async () => {
    const { state } = await renderPage({ queue: () => ok({ items: [] }) });
    await askToClose();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar cierre" }));
    expect(confirmButton()).toBeNull();
    expect(screen.getByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await askToClose("2500");
    expect(confirmButton()).toBeInTheDocument();
    await settle();
    expect(closePosts(state)).toHaveLength(0);
  });

  it("B03 confirming sends exactly one close with the confirmed amount", async () => {
    const { state } = await renderPage({ queue: () => ok({ items: [] }) });
    await askToClose("2000,50");
    fireEvent.click(confirmButton()!);
    expect(await screen.findByText("Conciliación de cierre")).toBeInTheDocument();
    expect(closePosts(state)).toHaveLength(1);
    expect(closePosts(state)[0].url).toContain("/cash/sessions/cs-CEN/close");
    expect(JSON.parse(closePosts(state)[0].body!)).toEqual({ closingCash: "200050" });
  });

  it("B04 a double click on the confirmation sends a single close", async () => {
    const pending = deferred<Reply>();
    const { state } = await renderPage({ queue: () => ok({ items: [] }), close: () => pending.promise });
    await askToClose();
    const button = confirmButton()!;
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(closePosts(state)).toHaveLength(1);
    pending.resolve(ok({}));
  });

  it("B05 an invalid amount never opens the confirmation", async () => {
    const { state, view } = await renderPage({ queue: () => ok({ items: [] }) });
    await askToClose("abc");
    expect(confirmButton()).toBeNull();
    expect(errorBanner(view.container)?.textContent).toBe("Ingresá un monto de cierre válido.");
    expect(closePosts(state)).toHaveLength(0);
  });

  it("B06 a branch change invalidates an open confirmation", async () => {
    const { state } = await renderPage({ user: cashier(["CEN", "DEP"]), queue: () => ok({ items: [] }) });
    await askToClose();
    const select = screen.getByRole("combobox", { name: /Sucursal autorizada/ });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: "DEP" } });
    expect(confirmButton()).toBeNull();
    expect(await screen.findByText("Caja depósito")).toBeInTheDocument();
    expect(confirmButton()).toBeNull();
    expect(closePosts(state)).toHaveLength(0);
  });

  it("B07 a different session after a refresh invalidates the confirmation", async () => {
    let sessionId = "cs-CEN";
    const { state } = await renderPage({ queue: () => ok({ items: [] }), session: (branchId) => openSession(branchId, sessionId) });
    await askToClose();
    expect(confirmButton()).toBeInTheDocument();
    sessionId = "cs-CEN-2";
    fireEvent.click(refreshButton());
    await waitFor(() => expect(confirmButton()).toBeNull());
    expect(closePosts(state)).toHaveLength(0);
  });

  it("B08 no reconciliation or closed notice is shown while the close is in flight", async () => {
    const pending = deferred<Reply>();
    await renderPage({ queue: () => ok({ items: [] }), close: () => pending.promise });
    await askToClose();
    fireEvent.click(confirmButton()!);
    await settle();
    expect(screen.queryByText("Conciliación de cierre")).toBeNull();
    expect(screen.queryByText(/Caja cerrada con/)).toBeNull();
    pending.resolve(ok({
      ...openSession("CEN"), status: "CLOSED", closedAt: "2030-01-02T18:00:00.000Z",
      closingCash: "200000", expectedCash: "200000", countedCash: "200000", difference: "0",
    }));
    expect(await screen.findByText("Conciliación de cierre")).toBeInTheDocument();
  });

  it("B09 a server error on close shows the error, no reconciliation, and closes the confirmation", async () => {
    const { view } = await renderPage({
      queue: () => ok({ items: [] }), close: () => ({ status: 409, body: { error: { message: "La caja ya está cerrada." } } }),
    });
    await askToClose();
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(errorBanner(view.container)?.textContent).toBe("La caja ya está cerrada."));
    expect(screen.queryByText("Conciliación de cierre")).toBeNull();
    expect(screen.queryByText(/Caja cerrada con/)).toBeNull();
    expect(confirmButton()).toBeNull();
  });

  it("B10 the closing amount cannot be edited under an open confirmation", async () => {
    await renderPage({ queue: () => ok({ items: [] }) });
    await askToClose();
    await settle();
    await settle();
    expect(closingInput()).toBeDisabled();
    expect(confirmButton()).toBeEnabled();
  });

  it("B11 a refresh that returns the same session keeps the confirmation", async () => {
    await renderPage({ queue: () => ok({ items: [] }) });
    await askToClose();
    fireEvent.click(refreshButton());
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    expect(confirmButton()).toBeInTheDocument();
  });

  it("B12 a malformed close answer after confirming still reports a plain close without amounts", async () => {
    await renderPage({ queue: () => ok({ items: [] }), close: () => ok({ unexpected: true }) });
    await askToClose();
    fireEvent.click(confirmButton()!);
    expect(await screen.findByText("Caja cerrada.")).toBeInTheDocument();
    expect(screen.queryByText("Conciliación de cierre")).toBeNull();
  });
});

describe("M1/M2 revision 1 (independent review findings)", () => {
  const polls: Array<() => void> = [];
  beforeEach(() => {
    window.localStorage.clear();
    polls.length = 0;
    // Captures only the 15 s cashier poll; every other interval (Testing
    // Library's waitFor) keeps the real timer.
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 15000) {
        polls.push(handler);
        return 0;
      }
      return realSetInterval(handler, ms, ...args);
    }) as typeof window.setInterval);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const poll = () => polls[polls.length - 1]();
  const valid = (remainingBalance = "1000000") => ok({ items: [row({ remainingBalance })] });

  it("A22 an older malformed queue answer never replaces a newer valid one", async () => {
    let reply: () => Reply | Promise<Reply> = () => valid();
    await renderPage({ queue: () => reply() });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    const older = deferred<Reply>();
    reply = () => older.promise;
    poll();
    reply = () => valid("700000");
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    fireEvent.click(refreshButton());
    await waitFor(() => expect(screen.getAllByText(/7\.000/).length).toBeGreaterThan(0));
    older.resolve(ok({}));
    await settle();
    await settle();
    expect(screen.queryByText(QUEUE_INVALID)).toBeNull();
    expect(screen.getByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
  });

  it("A23 an older valid queue answer never restores rows after a newer invalid one", async () => {
    let reply: () => Reply | Promise<Reply> = () => valid();
    await renderPage({ queue: () => reply() });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    const older = deferred<Reply>();
    reply = () => older.promise;
    poll();
    reply = () => ok({});
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    fireEvent.click(refreshButton());
    expect(await screen.findByText(QUEUE_INVALID)).toBeInTheDocument();
    older.resolve(valid());
    await settle();
    await settle();
    expect(screen.getByText(QUEUE_INVALID)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "CEN-V-000001" })).toBeNull();
  });

  it("A24 returning to a sale after a network failure keeps that sale's last validated payments", async () => {
    let firstRead = true;
    await renderPage({
      queue: () => ok({ items: [row(), row({ saleId: "sale-2", saleNumber: "CEN-V-000002" })] }),
      payments: (saleId) => {
        if (saleId !== "sale-1") return ok({ items: [] });
        if (firstRead) { firstRead = false; return ok({ items: [payment("sale-1")] }); }
        return { network: true };
      },
    });
    expect(await screen.findByText("key-sale-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /CEN-V-000002/ }));
    expect(await screen.findByText("Todavía no hay pagos registrados.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /CEN-V-000001/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument());
    await settle();
    await settle();
    expect(screen.getByText("key-sale-1")).toBeInTheDocument();
    expect(screen.queryByText("No se pudieron cargar los pagos.")).toBeNull();
  });

  it("A25 a payment that fails after another sale was selected is never offered for retry there", async () => {
    const post = deferred<Reply>();
    await renderPage({
      queue: () => ok({ items: [row(), row({ saleId: "sale-2", saleNumber: "CEN-V-000002" })] }),
      paymentPost: () => post.promise,
    });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    const pay = screen.getByRole("button", { name: /Registrar pago/ });
    await waitFor(() => expect(pay).toBeEnabled());
    fireEvent.click(pay);
    fireEvent.click(screen.getByRole("button", { name: /CEN-V-000002/ }));
    expect(await screen.findByRole("heading", { name: "CEN-V-000002" })).toBeInTheDocument();
    post.resolve({ status: 500, body: { error: { message: "Pago rechazado" } } });
    await settle();
    await settle();
    expect(screen.queryByRole("button", { name: "Reintentar mismo pago" })).toBeNull();
    expect(screen.getByText("Venta CEN-V-000001: Pago rechazado")).toBeInTheDocument();
  });

  it("A27 a payment that succeeds after another sale was selected names the sale it was registered on", async () => {
    const post = deferred<Reply>();
    await renderPage({
      queue: () => ok({ items: [row(), row({ saleId: "sale-2", saleNumber: "CEN-V-000002" })] }),
      paymentPost: () => post.promise,
    });
    expect(await screen.findByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    const pay = screen.getByRole("button", { name: /Registrar pago/ });
    await waitFor(() => expect(pay).toBeEnabled());
    fireEvent.click(pay);
    fireEvent.click(screen.getByRole("button", { name: /CEN-V-000002/ }));
    expect(await screen.findByRole("heading", { name: "CEN-V-000002" })).toBeInTheDocument();
    post.resolve({ status: 201, body: payment("sale-1") });
    expect(await screen.findByText(/registrado en la venta CEN-V-000001\./)).toBeInTheDocument();
  });

  it("B13 a close still in flight for the previous branch never blocks closing the selected one", async () => {
    const cenClose = deferred<Reply>();
    let closes = 0;
    const { state } = await renderPage({
      user: cashier(["CEN", "DEP"]),
      queue: () => ok({ items: [] }),
      close: () => (closes++ === 0 ? cenClose.promise : ok({})),
    });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre" }));
    await waitFor(() => expect(closePosts(state)).toHaveLength(1));
    fireEvent.change(screen.getByRole("combobox", { name: /Sucursal autorizada/ }), { target: { value: "DEP" } });
    expect(await screen.findByText("Caja depósito")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre" }));
    await waitFor(() => expect(closePosts(state)).toHaveLength(2));
    expect(closePosts(state)[1].url).toContain("/cash/sessions/cs-DEP/close");
    cenClose.resolve(ok({}));
  });

  it("B15 a close still in flight is never sent again after another branch's close finished", async () => {
    const cenClose = deferred<Reply>();
    let closes = 0;
    const { state, view } = await renderPage({
      user: cashier(["CEN", "DEP"]),
      queue: () => ok({ items: [] }),
      close: () => (closes++ === 0 ? cenClose.promise : ok({})),
    });
    const closeBranch = async (amount: string) => {
      await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled());
      fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: amount } });
      fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre" }));
    };
    const select = () => screen.getByRole("combobox", { name: /Sucursal autorizada/ });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await closeBranch("2000");
    await waitFor(() => expect(closePosts(state)).toHaveLength(1));
    fireEvent.change(select(), { target: { value: "DEP" } });
    expect(await screen.findByText("Caja depósito")).toBeInTheDocument();
    await closeBranch("3000");
    await waitFor(() => expect(closePosts(state)).toHaveLength(2));
    await waitFor(() => expect(select()).toBeEnabled());
    fireEvent.change(select(), { target: { value: "CEN" } });
    expect(await screen.findByText("Caja principal")).toBeInTheDocument();
    await closeBranch("2000");
    await settle();
    expect(closePosts(state).filter((call) => call.url.includes("/cs-CEN/"))).toHaveLength(1);
    expect(errorBanner(view.container)?.textContent).toBe("El cierre de esta caja ya está en curso.");
    cenClose.resolve(ok({}));
  });

  it("B16 a close in flight survives leaving and re-entering the cashier workspace", async () => {
    const cenClose = deferred<Reply>();
    const { state, view } = await renderPage({
      user: { ...cashier(), roles: ["CASHIER", "SELLER"] },
      queue: () => ok({ items: [] }),
      close: () => cenClose.promise,
    });
    const closeCurrent = async () => {
      expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled());
      fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: "2000" } });
      fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre" }));
    };
    await closeCurrent();
    await waitFor(() => expect(closePosts(state)).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Venta" }));
    await waitFor(() => expect(screen.queryByText("Ventas pendientes")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Caja" }));
    expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
    await closeCurrent();
    await settle();
    expect(closePosts(state)).toHaveLength(1);
    expect(errorBanner(view.container)?.textContent).toBe("El cierre de esta caja ya está en curso.");
    cenClose.resolve(ok({}));
    await settle();
  });

  it("C15 a close history row with an invalid date never shows \"Invalid Date\"", async () => {
    await renderPage({
      queue: () => ok({ items: [] }),
      history: [{
        sessionId: "cs-old", registerId: "reg-CEN", branchId: "CEN", openedById: "c1", closedById: "c1", startingCash: "0",
        status: "CLOSED", openedAt: "2030-01-01T09:00:00.000Z", closedAt: "not-a-date",
        expectedCash: "100000", countedCash: "100000", difference: "0",
      }],
    });
    expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
    expect(screen.getByText("fecha no informada")).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  it("B14 the confirmation names the full branch and session ids and never shows an invalid date", async () => {
    const branchId = "0f3c9a1e-1111-4222-8333-944455556666";
    await renderPage({
      user: cashier([branchId]),
      queue: () => ok({ items: [] }),
      session: (branch) => ({ ...openSession(branch, "0f3c9a1e-aaaa-4bbb-8ccc-dddddddddddd"), openedAt: "not-a-date" }),
    });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
    const panel = screen.getByRole("group", { name: "Confirmar cierre de caja" });
    expect(panel).toHaveTextContent(branchId);
    expect(panel).toHaveTextContent("0f3c9a1e-aaaa-4bbb-8ccc-dddddddddddd");
    expect(panel).toHaveTextContent("fecha no informada");
    expect(panel).not.toHaveTextContent("Invalid Date");
  });
});
