import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationsPage from "./page";

// CASH-1.1: cashier close history and reconciliation UI. The server stays
// authoritative (GET /cash/sessions re-checks CASH_SESSION_CLOSE at the
// register's own location); the client only decides whether to ask, and a
// history failure must never hide the operational cash state.

const TOKEN_KEY = "mona-jacinta-token";

type TestUser = {
  id: string; name: string; email: string; roles: string[]; branchIds: string[]; permissions: string[];
};

type HistoryEntry = {
  sessionId: string; registerId: string; branchId: string; openedById: string; closedById: string | null;
  startingCash: string; status: "CLOSED"; openedAt: string; closedAt: string | null;
  expectedCash: string | null; countedCash: string | null; difference: string | null;
};

type Reply = { status: number; body: unknown };

type ServerState = {
  user: TestUser;
  open: boolean;
  history: HistoryEntry[];
  historyReply?: Reply;
  registerReply?: Reply;
  // Per-branch, possibly delayed, history answer (branch-switch races).
  historyFor?: (branchId: string) => Promise<Reply>;
  // Branches whose session was closed, and an optional (delayed or malformed)
  // answer to POST /close that replaces the default successful close.
  closedBranches: Set<string>;
  closeReply?: () => Promise<Reply>;
  calls: Array<{ url: string; method: string }>;
};

const cashierUser = (permissions: string[]): TestUser => ({
  id: "c1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN"], permissions,
});
const CLOSE = ["sale.charge", "cash.session.open", "cash.session.close"];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function closedEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    sessionId: "cs-old", registerId: "reg-1", branchId: "CEN", openedById: "c1", closedById: "c1",
    startingCash: "0", status: "CLOSED", openedAt: "2030-01-01T09:00:00.000Z", closedAt: "2030-01-01T18:00:00.000Z",
    expectedCash: "1000000", countedCash: "950000", difference: "-50000", ...overrides,
  };
}

function openSession(branchId = "CEN") {
  return {
    sessionId: `cs-${branchId}`, registerId: `reg-${branchId}`, branchId, openedById: "c1", closedById: null,
    startingCash: "0", status: "OPEN", openedAt: "2030-01-02T09:00:00.000Z", closedAt: null,
  };
}

function createRouter(state: ServerState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    state.calls.push({ url, method });
    if (url.includes("/auth/me")) return jsonResponse({ user: state.user });
    if (url.includes("/sales/pending")) return jsonResponse({ items: [] });
    if (url.includes("/cash/sessions/") && url.endsWith("/close") && method === "POST") {
      if (state.closeReply) {
        const reply = await state.closeReply();
        return jsonResponse(reply.body, reply.status);
      }
      const branchId = url.includes("/cs-DEP/") ? "DEP" : "CEN";
      const closed = closedEntry({
        sessionId: `cs-${branchId}`, branchId, closedAt: "2030-01-02T18:00:00.000Z", expectedCash: "200000", countedCash: "200000", difference: "0",
      });
      state.closedBranches.add(branchId);
      state.history = [closed, ...state.history];
      return jsonResponse({ ...closed, closingCash: "200000" });
    }
    if (url.includes("/cash/sessions?")) {
      if (state.historyFor) {
        const reply = await state.historyFor(new URL(url, "http://x").searchParams.get("branchId") ?? "");
        return jsonResponse(reply.body, reply.status);
      }
      if (state.historyReply) return jsonResponse(state.historyReply.body, state.historyReply.status);
      return jsonResponse(state.history);
    }
    const branchOf = () => new URL(url, "http://x").searchParams.get("branchId") ?? "";
    if (url.includes("/cash/current")) {
      const branchId = branchOf();
      return jsonResponse(state.open && !state.closedBranches.has(branchId) ? openSession(branchId) : null);
    }
    if (url.includes("/cash/register")) {
      if (state.registerReply) return jsonResponse(state.registerReply.body, state.registerReply.status);
      const branchId = branchOf();
      return jsonResponse({ id: `reg-${branchId}`, branchId, name: branchId === "DEP" ? "Caja depósito" : "Caja principal" });
    }
    if (url.includes("/variants")) return jsonResponse({ items: [] });
    return jsonResponse({ items: [] });
  });
}

async function renderPage(partial: Partial<ServerState> & { user: TestUser }) {
  const state: ServerState = { open: true, history: [], calls: [], closedBranches: new Set(), ...partial };
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createRouter(state));
  const view = render(<OperationsPage />);
  await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
  return { state, view };
}

const historyCalls = (state: ServerState) =>
  state.calls.filter((call) => call.method === "GET" && call.url.includes("/cash/sessions?"));
const errorBanner = (container: HTMLElement) => container.querySelector(".error-banner");
// Lets every pending refresh promise settle before asserting an absence.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const twoBranchCashier = () => ({ ...cashierUser(CLOSE), branchIds: ["CEN", "DEP"] });
const branchSelect = () => screen.getByRole("combobox", { name: /Sucursal autorizada/ });
const CEN_ROW = closedEntry({ sessionId: "cs-cen", countedCash: "950000" });
const DEP_ROW = closedEntry({ sessionId: "cs-dep", branchId: "DEP", countedCash: "300000", expectedCash: "300000", difference: "0" });

describe("CASH-1.1 cashier close history", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("C01 a cashier without cash.session.close never requests the history and still sees the open register", async () => {
    const { state, view } = await renderPage({ user: cashierUser(["sale.charge"]) });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await settle();
    expect(historyCalls(state)).toHaveLength(0);
    expect(errorBanner(view.container)).toBeNull();
  });

  it("C11 cash.session.open alone does not enable the history request", async () => {
    const { state } = await renderPage({ user: cashierUser(["sale.charge", "cash.session.open"]) });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await settle();
    expect(historyCalls(state)).toHaveLength(0);
  });

  it("C10 the history request is scoped to the selected branch", async () => {
    const { state } = await renderPage({ user: cashierUser(CLOSE), history: [closedEntry()] });
    expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
    expect(historyCalls(state).map((call) => new URL(call.url, "http://x").searchParams.get("branchId"))).toContain("CEN");
  });

  for (const status of [403, 500]) {
    it(`C02/C03 a ${status} from the history keeps the current register visible without an error banner`, async () => {
      const { state, view } = await renderPage({
        user: cashierUser(CLOSE), historyReply: { status, body: { error: { code: "X", message: "fallo historial" } } },
      });
      expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
      expect(screen.getByText("Caja principal")).toBeInTheDocument();
      await waitFor(() => expect(historyCalls(state).length).toBeGreaterThan(0));
      await settle();
      expect(errorBanner(view.container)).toBeNull();
      expect(screen.queryByText("Cierres recientes")).toBeNull();
      expect(screen.getByText("No se pudo cargar el historial de cierres.")).toBeInTheDocument();
    });
  }

  it("C04 a non-array history payload is ignored without breaking the page", async () => {
    const { view } = await renderPage({ user: cashierUser(CLOSE), historyReply: { status: 200, body: { length: 1 } } });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Cierres recientes")).toBeNull();
    expect(errorBanner(view.container)).toBeNull();
    // A successful but malformed payload is not a request failure: the guard
    // must reject it before processing, never by catching a TypeError.
    expect(screen.queryByText("No se pudo cargar el historial de cierres.")).toBeNull();
  });

  it("C04b malformed rows inside an array are dropped and valid rows still render", async () => {
    await renderPage({
      user: cashierUser(CLOSE),
      historyReply: { status: 200, body: [null, 5, "x", { countedCash: "1" }, closedEntry()] },
    });
    expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
    expect(screen.getAllByText(/^Contado\s*\$\s*9\.500$/)).toHaveLength(1);
    expect(screen.queryByText("No se pudo cargar el historial de cierres.")).toBeNull();
  });

  it("C05 a pre-CASH-1 close shows 'Contado no registrado' and 'Sin conciliar', never a zero count", async () => {
    await renderPage({
      user: cashierUser(CLOSE),
      history: [closedEntry({ expectedCash: null, countedCash: null, difference: null })],
    });
    expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
    expect(screen.getByText("Contado no registrado")).toBeInTheDocument();
    expect(screen.getByText("Sin conciliar")).toBeInTheDocument();
    expect(screen.queryByText(/Contado\s*\$\s*0$/)).toBeNull();
  });

  it("C06 a reconciled close shows the counted amount and the signed difference", async () => {
    await renderPage({ user: cashierUser(CLOSE), history: [closedEntry()] });
    expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
    expect(screen.getByText(/^Contado\s*\$\s*9\.500$/)).toBeInTheDocument();
    expect(screen.getByText(/^Diferencia\s*-\$\s*500$/)).toBeInTheDocument();
    expect(screen.queryByText("Sin conciliar")).toBeNull();
  });

  it("C08 a register failure is reported while the history still loads independently", async () => {
    const { view } = await renderPage({
      user: cashierUser(CLOSE), history: [closedEntry()],
      registerReply: { status: 500, body: { error: { code: "X", message: "Caja no disponible" } } },
    });
    expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
    await waitFor(() => expect(errorBanner(view.container)).not.toBeNull());
  });

  it("C09 closing the register re-fetches the history and shows the new reconciled close", async () => {
    const { state } = await renderPage({ user: cashierUser(CLOSE) });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
    // M2: the close is only sent after the explicit confirmation.
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre" }));
    expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
    expect(historyCalls(state).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/^Diferencia\s*\$\s*0$/).length).toBeGreaterThan(0);
  });
});

describe("CASH-1.1 branch-bound history", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("C12 a pending history never keeps the branch selector or refresh disabled", async () => {
    const cen = deferred<Reply>();
    await renderPage({ user: twoBranchCashier(), historyFor: () => cen.promise });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await waitFor(() => expect(branchSelect()).toBeEnabled());
    expect(screen.getByRole("button", { name: "Actualizar" })).toBeEnabled();
    cen.resolve({ status: 200, body: [] });
  });

  it("C13 a late answer for the previous branch never replaces the selected branch history", async () => {
    const cen = deferred<Reply>();
    await renderPage({
      user: twoBranchCashier(),
      historyFor: (branchId) => (branchId === "CEN" ? cen.promise : Promise.resolve({ status: 200, body: [DEP_ROW] })),
    });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await waitFor(() => expect(branchSelect()).toBeEnabled());
    fireEvent.change(branchSelect(), { target: { value: "DEP" } });
    expect(await screen.findByText(/^Contado\s*\$\s*3\.000$/)).toBeInTheDocument();
    cen.resolve({ status: 200, body: [CEN_ROW] });
    await settle();
    await settle();
    expect(screen.queryByText(/^Contado\s*\$\s*9\.500$/)).toBeNull();
    expect(screen.getByText(/^Contado\s*\$\s*3\.000$/)).toBeInTheDocument();
  });

  it("C14 switching branch clears the previous branch history while the new one loads", async () => {
    const dep = deferred<Reply>();
    await renderPage({
      user: twoBranchCashier(),
      historyFor: (branchId) => (branchId === "CEN" ? Promise.resolve({ status: 200, body: [CEN_ROW] }) : dep.promise),
    });
    expect(await screen.findByText(/^Contado\s*\$\s*9\.500$/)).toBeInTheDocument();
    await waitFor(() => expect(branchSelect()).toBeEnabled());
    fireEvent.change(branchSelect(), { target: { value: "DEP" } });
    await waitFor(() => expect(screen.queryByText(/^Contado\s*\$\s*9\.500$/)).toBeNull());
    dep.resolve({ status: 200, body: [DEP_ROW] });
    expect(await screen.findByText(/^Contado\s*\$\s*3\.000$/)).toBeInTheDocument();
  });
});

describe("CASH-1.1 iteration 2: close result is branch-bound", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const reconciliation = () => screen.queryByText("Conciliación de cierre");
  async function closeCurrent(amount = "2000") {
    fireEvent.change(screen.getByRole("textbox", { name: /Cierre ARS/ }), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar caja" }));
    // M2: the close is only sent after the explicit confirmation.
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre" }));
  }
  async function switchTo(branchId: string) {
    await waitFor(() => expect(branchSelect()).toBeEnabled());
    fireEvent.change(branchSelect(), { target: { value: branchId } });
    await waitFor(() => expect(branchSelect()).toHaveValue(branchId));
  }

  it("D05 the reconciliation of a close stays visible on the same branch", async () => {
    await renderPage({ user: twoBranchCashier() });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await closeCurrent();
    expect(await screen.findByText("Conciliación de cierre")).toBeInTheDocument();
  });

  it("D01/D06 switching branch after a close hides the previous branch reconciliation and shows the new history", async () => {
    await renderPage({
      user: twoBranchCashier(),
      historyFor: (branchId) => Promise.resolve({ status: 200, body: branchId === "DEP" ? [DEP_ROW] : [] }),
    });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await closeCurrent();
    expect(await screen.findByText("Conciliación de cierre")).toBeInTheDocument();
    await switchTo("DEP");
    expect(await screen.findByText(/^Contado\s*\$\s*3\.000$/)).toBeInTheDocument();
    expect(reconciliation()).toBeNull();
  });

  it("D02 returning to the original branch does not resurrect the invalidated reconciliation", async () => {
    await renderPage({ user: twoBranchCashier() });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await closeCurrent();
    expect(await screen.findByText("Conciliación de cierre")).toBeInTheDocument();
    await switchTo("DEP");
    await switchTo("CEN");
    await settle();
    expect(reconciliation()).toBeNull();
  });

  it("D03 rapid branch switching never shows a reconciliation of another branch", async () => {
    await renderPage({ user: twoBranchCashier() });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await closeCurrent();
    expect(await screen.findByText("Conciliación de cierre")).toBeInTheDocument();
    fireEvent.change(branchSelect(), { target: { value: "DEP" } });
    fireEvent.change(branchSelect(), { target: { value: "CEN" } });
    fireEvent.change(branchSelect(), { target: { value: "DEP" } });
    await waitFor(() => expect(branchSelect()).toHaveValue("DEP"));
    await settle();
    expect(reconciliation()).toBeNull();
  });

  it("D04 a late close answer for the previous branch never writes into the selected branch", async () => {
    const close = deferred<Reply>();
    const { view } = await renderPage({ user: twoBranchCashier(), closeReply: () => close.promise });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await closeCurrent();
    fireEvent.change(branchSelect(), { target: { value: "DEP" } });
    expect(await screen.findByText("Caja depósito")).toBeInTheDocument();
    close.resolve({
      status: 200,
      body: { ...closedEntry({ sessionId: "cs-CEN", expectedCash: "200000", countedCash: "200000", difference: "0" }), closingCash: "200000" },
    });
    await settle();
    await settle();
    expect(reconciliation()).toBeNull();
    expect(screen.queryByText(/Caja cerrada con/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    expect(errorBanner(view.container)).toBeNull();
  });

  it("D16 a malformed close answer neither crashes nor shows invented amounts", async () => {
    await renderPage({
      user: twoBranchCashier(),
      closeReply: async () => ({
        status: 200,
        body: { ...closedEntry({ sessionId: "cs-CEN", expectedCash: "200000", countedCash: "abc", difference: "0" }), closingCash: "abc" },
      }),
    });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await closeCurrent();
    expect(await screen.findByText("Caja cerrada.")).toBeInTheDocument();
    expect(reconciliation()).toBeNull();
  });
});

describe("CASH-1.1 iteration 2: malformed history amounts", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const VALID = closedEntry({ sessionId: "cs-valid" });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["D07 countedCash as a JSON number", { countedCash: 950000 }],
    ["D08 countedCash not numeric", { countedCash: "abc" }],
    ["D09 countedCash empty string", { countedCash: "" }],
    ["D10 countedCash object", { countedCash: {} }],
    ["D11 difference not numeric", { difference: "x" }],
    ["D13 negative countedCash", { countedCash: "-100" }],
    ["D15 countedCash decimal string", { countedCash: "1.5" }],
  ];
  for (const [name, patch] of cases) {
    it(`${name}: the row is dropped, the valid row still renders, nothing crashes`, async () => {
      const bad = { ...closedEntry({ sessionId: "cs-bad", countedCash: "120000" }), ...patch };
      await renderPage({ user: cashierUser(CLOSE), historyReply: { status: 200, body: [bad, VALID] } });
      expect(await screen.findByText("Cierres recientes")).toBeInTheDocument();
      expect(screen.getAllByText(/^Contado/)).toHaveLength(1);
      expect(screen.getByText(/^Contado\s*\$\s*9\.500$/)).toBeInTheDocument();
      expect(screen.queryByText(/^Contado\s*\$\s*0$/)).toBeNull();
      expect(screen.queryByText("No se pudo cargar el historial de cierres.")).toBeNull();
    });
  }

  it("D12 countedCash null still reads 'Contado no registrado'", async () => {
    await renderPage({
      user: cashierUser(CLOSE),
      historyReply: { status: 200, body: [closedEntry({ countedCash: null, expectedCash: null, difference: null })] },
    });
    expect(await screen.findByText("Contado no registrado")).toBeInTheDocument();
  });

  it("D14 a history made only of malformed rows renders nothing and keeps the register", async () => {
    await renderPage({
      user: cashierUser(CLOSE),
      historyReply: { status: 200, body: [closedEntry({ sessionId: "a", countedCash: "abc" as unknown as string }), closedEntry({ sessionId: "b", difference: "-" })] },
    });
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("Cierres recientes")).toBeNull();
    expect(screen.queryByText("No se pudo cargar el historial de cierres.")).toBeNull();
  });
});

describe("CASH-1.1 seller isolation", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("C07 a SELLER never calls any /cash/ route", async () => {
    const seller = { ...cashierUser(["sale.create"]), id: "s1", name: "Vendedor", roles: ["SELLER"] };
    const { state } = await renderPage({ user: seller });
    await waitFor(() => expect(state.calls.some((call) => call.url.includes("/auth/me"))).toBe(true));
    await settle();
    expect(state.calls.filter((call) => call.url.includes("/cash/"))).toEqual([]);
  });
});
