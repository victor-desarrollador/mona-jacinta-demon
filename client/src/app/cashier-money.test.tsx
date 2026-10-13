import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";

// H1 + H2 (UI/UX audit): money is BigInt centavos end to end. The cashier UI must show every
// amount exactly (centavos and sign kept, no BigInt -> Number precision loss) and prefill the
// "Recibido" and split-payment inputs with the exact server balance, so a centavo total is
// neither blocked nor under-paid. Whole-peso amounts keep their existing format ("$ 9.500").

const TOKEN_KEY = "mona-jacinta-token";

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Row = Record<string, unknown>;

const cashier = {
  id: "c1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN"],
  permissions: ["sale.charge", "cash.session.open", "cash.session.close"],
};

const openSession = {
  sessionId: "cs-1", registerId: "reg-1", branchId: "CEN", openedById: "c1", closedById: null,
  startingCash: "0", status: "OPEN", openedAt: "2030-01-01T09:00:00.000Z", closedAt: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(overrides: Row = {}): Row {
  return {
    saleId: "sale-1", saleNumber: "CEN-V-000001", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [{ id: "i1", variantId: "v1", productName: "Remera", variantName: "Negro / M", sku: "R-1", quantity: "1", unitPrice: "120940", subtotal: "120940" }],
    subtotal: "120940", total: "120940", paidAmount: "0", remainingBalance: "120940",
    holdState: "VALID", canAcceptPayment: true, paymentCount: 0, canCorrect: false, canCancel: false,
    ...overrides,
  };
}

type Server = { queue: Row[]; payments?: Row[]; history?: Row[]; closingCash?: string };

function createRouter(server: Server, calls: Call[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: server.queue });
    if (url.includes("/payments") && method === "POST") return jsonResponse({ id: "p-new" }, 201);
    if (url.includes("/payments")) return jsonResponse({ items: server.payments ?? [] });
    if (url.includes("/cash/sessions/") && url.endsWith("/close") && method === "POST") {
      const closingCash = server.closingCash ?? "0";
      return jsonResponse({ ...openSession, status: "CLOSED", closedAt: "2030-01-01T18:00:00.000Z", expectedCash: closingCash, countedCash: closingCash, difference: "0", closingCash });
    }
    if (url.includes("/cash/sessions?")) return jsonResponse(server.history ?? []);
    if (url.includes("/cash/current")) return jsonResponse(openSession);
    if (url.includes("/cash/register")) return jsonResponse({ id: "reg-1", branchId: "CEN", name: "Caja principal" });
    return jsonResponse({ items: [] });
  });
}

async function renderCashier(server: Server) {
  const calls: Call[] = [];
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createRouter(server, calls));
  const view = render(<OperationsPage />);
  await screen.findByRole("heading", { name: String(server.queue[0]?.saleNumber ?? "Ventas pendientes") });
  return { calls, view };
}

// Intl separates "$" from the digits with a no-break space; \s matches it.
const money = (text: string) => new RegExp(text.replace("$", "\\$\\s*").replace(/\./g, "\\.").replace(/\s+/g, "\\s*"));
const paymentPosts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.includes("/payments"));
const registerButton = () => screen.getByRole("button", { name: /Registrar pago/ });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cashier money display is exact (H1)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("M01 shows centavos of a centavo total", async () => {
    await renderCashier({ queue: [row()] });
    expect(screen.getAllByText(money("$ 1.209,40")).length).toBeGreaterThan(0);
  });

  it("M02 keeps the whole-peso format unchanged", async () => {
    await renderCashier({ queue: [row({ total: "121000", subtotal: "121000", remainingBalance: "121000", items: [] })] });
    expect(screen.getAllByText(/^\$\s*1\.210$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(money("$ 1.210,00"))).toBeNull();
  });

  it("M03 keeps the sign and centavos of a negative balance", async () => {
    await renderCashier({ queue: [row({ remainingBalance: "-45" })] });
    expect(screen.getAllByText(/-\$\s*0,45/).length).toBeGreaterThan(0);
  });

  it("M04 shows signed cash differences exactly", async () => {
    await renderCashier({
      queue: [row()],
      history: [
        { sessionId: "h1", registerId: "reg-1", branchId: "CEN", openedById: "c1", closedById: "c1", startingCash: "0", status: "CLOSED", openedAt: "2030-01-01T09:00:00.000Z", closedAt: "2030-01-01T18:00:00.000Z", expectedCash: "100000", countedCash: "50000", difference: "-50000" },
        { sessionId: "h2", registerId: "reg-1", branchId: "CEN", openedById: "c1", closedById: "c1", startingCash: "0", status: "CLOSED", openedAt: "2030-01-02T09:00:00.000Z", closedAt: "2030-01-02T18:00:00.000Z", expectedCash: "100458", countedCash: "100000", difference: "-458" },
      ],
    });
    expect(await screen.findByText(/^Diferencia\s*-\$\s*500$/)).toBeInTheDocument();
    expect(screen.getByText(/^Diferencia\s*-\$\s*4,58$/)).toBeInTheDocument();
  });

  it("M07 shows a one-centavo balance", async () => {
    await renderCashier({ queue: [row({ remainingBalance: "1" })] });
    expect(screen.getAllByText(/\$\s*0,01/).length).toBeGreaterThan(0);
  });

  it("M08 formats amounts beyond 2^53 centavos without precision loss", async () => {
    await renderCashier({ queue: [row({ total: "900719925474099312", subtotal: "900719925474099312", remainingBalance: "900719925474099312", items: [] })] });
    expect(screen.getAllByText(money("$ 9.007.199.254.740.993,12")).length).toBeGreaterThan(0);
  });

  it("M09 shows a centavo unit price in the item list", async () => {
    await renderCashier({ queue: [row({ items: [{ id: "i1", variantId: "v1", productName: "Media", variantName: "U", sku: "M", quantity: "2", unitPrice: "50025", subtotal: "100050" }], subtotal: "100050", total: "100050", remainingBalance: "100050" })] });
    expect(screen.getAllByText(/\$\s*500,25/).length).toBeGreaterThan(0);
  });

  it("M11 shows a centavo payment amount and a missing received amount as zero", async () => {
    await renderCashier({
      queue: [row({ paidAmount: "99", remainingBalance: "120841", paymentCount: 1, holdState: "PAYMENT_PROTECTED" })],
      payments: [{ id: "p1", saleId: "sale-1", method: "CASH", amount: "99", receivedAmount: null, changeAmount: null, cashSessionId: "cs-1", idempotencyKey: "k1", paidAt: "2030-01-01T10:00:00.000Z" }],
    });
    expect((await screen.findAllByText(/\$\s*0,99/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Recibido\s*\$\s*0\s*\|/)).toBeInTheDocument();
  });

  it("M12 shows zero as $ 0", async () => {
    await renderCashier({ queue: [row({ total: "0", subtotal: "0", remainingBalance: "0", items: [] })] });
    expect(screen.getAllByText(/^\$\s*0$/).length).toBeGreaterThan(0);
  });
});

describe("cashier payment prefill is exact (H2)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("M05 a non-split CASH payment of a centavo balance is prefilled exactly and accepted", async () => {
    const { calls, view } = await renderCashier({ queue: [row()] });
    const received = screen.getByRole("textbox", { name: /Recibido ARS/ }) as HTMLInputElement;
    // The prefill is written by a passive effect after the sale is selected, which may not
    // have run yet when the heading appears: wait for it, the exact value stays asserted.
    await waitFor(() => expect(received.value).toBe("1209,40"));
    fireEvent.click(registerButton());
    await waitFor(() => expect(paymentPosts(calls)).toHaveLength(1));
    expect(paymentPosts(calls)[0]!.body).toMatchObject({ method: "CASH", amount: "120940", receivedAmount: "120940" });
    expect(view.container.querySelector(".error-banner")).toBeNull();
  });

  it("M06 the split prefill is the exact balance and a typed centavo amount is sent exactly", async () => {
    const { calls } = await renderCashier({ queue: [row()] });
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Pago parcial/ }));
    const amount = screen.getByRole("textbox", { name: /Importe ARS/ }) as HTMLInputElement;
    expect(amount.value).toBe("1209,40");
    fireEvent.change(amount, { target: { value: "500,25" } });
    fireEvent.click(registerButton());
    await waitFor(() => expect(paymentPosts(calls)).toHaveLength(1));
    expect(paymentPosts(calls)[0]!.body).toMatchObject({ method: "TRANSFER", amount: "50025" });
  });

  it("M07b a one-centavo balance prefills 0,01 when splitting", async () => {
    await renderCashier({ queue: [row({ remainingBalance: "1" })] });
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Pago parcial/ }));
    expect((screen.getByRole("textbox", { name: /Importe ARS/ }) as HTMLInputElement).value).toBe("0,01");
  });

  it("M10 the change box shows exact centavos", async () => {
    await renderCashier({ queue: [row()] });
    fireEvent.change(screen.getByRole("textbox", { name: /Recibido ARS/ }), { target: { value: "1300" } });
    const changeBox = screen.getByText("Vuelto").parentElement as HTMLElement;
    expect(within(changeBox).getByText(/\$\s*90,60/)).toBeInTheDocument();
  });

  it("M13 a non-split TRANSFER still sends the exact server balance", async () => {
    const { calls } = await renderCashier({ queue: [row()] });
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    fireEvent.click(registerButton());
    await waitFor(() => expect(paymentPosts(calls)).toHaveLength(1));
    expect(paymentPosts(calls)[0]!.body).toMatchObject({ method: "TRANSFER", amount: "120940" });
  });

  it("M14 the close notice shows the counted amount with centavos", async () => {
    await renderCashier({ queue: [row()], closingCash: "200050" });
    fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: "2000,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
    expect(await screen.findByText(money("Caja cerrada con $ 2.000,50"))).toBeInTheDocument();
    await settle();
  });
});
