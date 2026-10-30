import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";
import ExchangeWorkspace, { exchangeAuthorizedBranchIds } from "./ExchangeWorkspace";
import { ATTEMPT_KEY_PREFIX, attemptStorageKey, exchangeDrafts, markStorageKey } from "./exchange-draft-store";
import AUTH_ME from "./test-fixtures/auth-me.json";

// Cambios de prenda, UI-1: the tab, the branch authority and the Web Locks guard. Nothing is searched or sent yet.
//
// PRE-REGISTERED EXPECTATIONS: EW01..EW08.
//   - the tab "Cambios" exists only when intersection(user.branchIds, user.saleExchangeLocationIds) is not empty;
//   - the selector offers exactly that intersection; labels (user.branches) are display text, the authority is the branch ID;
//   - without Web Locks (navigator.locks) the workspace says so and offers no way to start;
//   - entering the tab starts IDLE and requests nothing.
// The /auth/me payloads start from the REAL public projection (test-fixtures/auth-me.json, pinned by api/tests/auth/auth-me-client-fixture.test.ts).

const TOKEN_KEY = "mona-jacinta-token";

const json = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

type Branch = { id: string; name: string; code: string };
type UserOverrides = { branchIds?: string[]; branches?: Branch[]; saleExchangeLocationIds?: string[] | undefined };

function owner(overrides: UserOverrides = {}) {
  const base = { id: "u1", name: "Test User", email: "test@demo.local", ...AUTH_ME.OWNER, branchIds: ["branch-1"] };
  const merged = { ...base, ...overrides };
  // an explicit `undefined` models an API that predates the field
  if ("saleExchangeLocationIds" in overrides && overrides.saleExchangeLocationIds === undefined) delete (merged as Record<string, unknown>).saleExchangeLocationIds;
  return merged;
}

let calls: string[] = [];

function stub(me: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/auth/me")) return json({ user: me });
    if (url.pathname.endsWith("/variants")) return json({ items: [], pagination: { page: 1, limit: 100, total: 0 } });
    return json({ items: [] });
  }));
}

// jsdom has no Web Locks. The store reads navigator.locks at the moment of use, so this is enough to flip the guard.
function setLocks(available: boolean) {
  Object.defineProperty(navigator, "locks", { value: available ? { request: vi.fn() } : undefined, configurable: true });
}

async function ready() {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  render(<OperationsPage />);
  await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
  await screen.findByRole("button", { name: "Venta" });
}

const tab = () => screen.queryByRole("button", { name: "Cambios" });
const optionsOf = (select: HTMLElement) => within(select).getAllByRole("option").map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent }));

describe("ExchangeWorkspace UI-1 — tab, branch authority and Web Locks guard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLocks(true);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "locks");
  });

  it("EW01 without authority there is no Cambios tab: empty hint, a hint that does not meet branchIds, or an API that predates the field", async () => {
    for (const overrides of [
      { saleExchangeLocationIds: [] },
      { branchIds: ["branch-1"], saleExchangeLocationIds: ["branch-9"] },
      { saleExchangeLocationIds: undefined },
    ] as UserOverrides[]) {
      stub(owner(overrides));
      await ready();
      expect(tab(), JSON.stringify(overrides)).toBeNull();
      cleanup();
      window.localStorage.clear();
    }
  });

  it("EW02 with saleExchangeLocationIds meeting branchIds the Cambios tab is there, not pressed until chosen", async () => {
    stub(owner());
    await ready();
    expect(tab()).toBeInTheDocument();
    expect(tab()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(tab()!);
    expect(tab()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Venta" })).toHaveAttribute("aria-pressed", "false");
  });

  it("EW03 the selector offers exactly the intersection, in branchIds order, and no other branch of `branches`", async () => {
    const branches = [
      { id: "A", name: "Alfa", code: "AL" }, { id: "B", name: "Beta", code: "BE" }, { id: "C", name: "Gamma", code: "GA" }, { id: "Z", name: "Zeta", code: "ZE" },
    ];
    stub(owner({ branchIds: ["A", "B", "C"], branches, saleExchangeLocationIds: ["B", "A", "Z"] }));
    await ready();
    fireEvent.click(tab()!);
    const select = await screen.findByRole("combobox", { name: /Sucursal autorizada/ });
    expect(optionsOf(select).map((option) => option.value)).toEqual(["A", "B"]);
  });

  it("EW04 the option text comes from `branches` (name + code) and the authority stays the branch ID: a label that imitates an id grants nothing", async () => {
    const branches = [
      { id: "a-id", name: "b-id", code: "b-id" }, // its label mimics the other branch's id
      { id: "b-id", name: "Beta", code: "BE" },
    ];
    stub(owner({ branchIds: ["a-id", "b-id"], branches, saleExchangeLocationIds: ["b-id"] }));
    await ready();
    fireEvent.click(tab()!);
    const select = await screen.findByRole("combobox", { name: /Sucursal autorizada/ });
    expect(optionsOf(select)).toEqual([{ value: "b-id", text: "Beta (BE)" }]);
  });

  it("EW05 without Web Locks the workspace says why and offers no way to start", async () => {
    setLocks(false);
    stub(owner());
    await ready();
    fireEvent.click(tab()!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Web Locks/);
    expect(alert).toHaveTextContent(/HTTPS|contexto seguro/);
    expect(screen.queryByRole("button", { name: /Buscar venta/ })).toBeNull();
    expect(screen.queryByLabelText(/Número de venta/)).toBeNull();
    expect(document.querySelector("[data-phase]")).toHaveAttribute("data-phase", "IDLE");
  });

  it("EW05b with Web Locks there is no blocking message and the sale-number field is there", async () => {
    stub(owner());
    await ready();
    fireEvent.click(tab()!);
    await screen.findByLabelText(/Número de venta/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("EW06 entering Cambios starts IDLE and requests nothing (no sale, catalog or exchange call)", async () => {
    stub(owner());
    await ready();
    await waitFor(() => expect(calls.some((call) => call.endsWith("/variants"))).toBe(true)); // the Venta tab loaded its catalog
    const before = calls.length;
    fireEvent.click(tab()!);
    await screen.findByLabelText(/Número de venta/);
    expect(document.querySelector("[data-phase]")).toHaveAttribute("data-phase", "IDLE");
    expect(calls.slice(before)).toEqual([]);
  });

  it("EW07 the authority helper keeps branchIds order, drops anything outside the hint, and tolerates a missing hint", () => {
    expect(exchangeAuthorizedBranchIds({ branchIds: ["A", "B", "C"], saleExchangeLocationIds: ["C", "A", "Z"] })).toEqual(["A", "C"]);
    expect(exchangeAuthorizedBranchIds({ branchIds: ["A", "A", "B"], saleExchangeLocationIds: ["A", "B"] })).toEqual(["A", "B"]);
    expect(exchangeAuthorizedBranchIds({ branchIds: ["A"], saleExchangeLocationIds: [] })).toEqual([]);
    expect(exchangeAuthorizedBranchIds({ branchIds: ["A"] })).toEqual([]);
    expect(exchangeAuthorizedBranchIds({ branchIds: [], saleExchangeLocationIds: ["A"] })).toEqual([]);
  });

  it("EW08 the workspace itself offers only the ids it is given and reports no fetch on mount", () => {
    stub(owner());
    render(<ExchangeWorkspace token="t" userId="u1" onSessionExpired={() => {}} branchIds={["x1", "x2"]} labels={[{ id: "x1", name: "Uno", code: "U1" }, { id: "x2", name: "Dos", code: "D2" }, { id: "x3", name: "Tres", code: "T3" }]} />);
    const select = screen.getByRole("combobox", { name: /Sucursal autorizada/ });
    expect(optionsOf(select)).toEqual([{ value: "x1", text: "Uno (U1)" }, { value: "x2", text: "Dos (D2)" }]);
    expect(calls).toEqual([]);
  });
});

// UI-2: sale lookup + fresh read + opening the draft. PRE-REGISTERED EXPECTATIONS: EW09..EW22.
//   - "Buscar venta" needs guard + branch + trimmed sale number + no request in flight; one request per search (double click included);
//   - the GET body goes RAW to exchangeDrafts.openDraftFromFreshRead; only { ok: true } reaches SALE_LOADED;
//   - every refusal of the store has its own message and leaves the flow non-editable; 401 hands over to onSessionExpired once;
//   - changing branch or sale number only clears the local view: no clearAll, no persisted draft touched.
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_A = "22222222-2222-4222-8222-222222222222";
const ITEM_B = "33333333-3333-4333-8333-333333333333";
const WHO = { token: "tok", userId: "u1", branchIds: ["b1", "b2"], labels: [{ id: "b1", name: "Centro", code: "CE" }, { id: "b2", name: "Norte", code: "NO" }] };

type Row = { saleItemId: string; quantity: string; exchangedQuantity: string; remainingQuantity: string; sku?: string };
const row = (saleItemId: string, quantity: string, exchangedQuantity: string, remainingQuantity: string, sku = "SKU-" + saleItemId[0]): Row => ({ saleItemId, quantity, exchangedQuantity, remainingQuantity, sku });
function readBody(rows: Row[], branchId = "b1", saleNumber = "T-1") {
  return {
    sale: { id: SALE_ID, saleNumber, branchId, status: "COMPLETED", pricingMode: "RETAIL", priceMode: "LIST", total: "1250000" },
    exchangeable: true,
    lines: rows.map((r) => ({ variantId: "variant-" + r.saleItemId[0], productName: "Remera", variantName: "Negro / M", unitPrice: "1250000", ...r })),
  };
}

let gets: string[] = [];
let release: (() => void) | null = null;
const letGo = async () => { await waitFor(() => expect(release).not.toBeNull()); release!(); };
function stubSearch(respond: () => { status: number; body: unknown }, hold = false) {
  gets = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    gets.push(String(input));
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    const { status, body } = respond();
    return json(body, status);
  }));
}

function mount(overrides: Partial<{ onSessionExpired: () => void }> = {}) {
  const onSessionExpired = overrides.onSessionExpired ?? vi.fn();
  render(<ExchangeWorkspace {...WHO} onSessionExpired={onSessionExpired} />);
  return onSessionExpired;
}
const phase = () => document.querySelector("[data-phase]")!.getAttribute("data-phase");
const typeSale = (value: string) => fireEvent.change(screen.getByLabelText(/Número de venta/), { target: { value } });
const searchButton = () => screen.getByRole("button", { name: /Buscar venta/ });

describe("ExchangeWorkspace UI-2 — sale lookup, fresh read and opening the draft", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, "locks", { value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() }, configurable: true });
    exchangeDrafts.clearAll();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    release = null;
    Reflect.deleteProperty(navigator, "locks");
  });

  it("EW09 the search button is enabled only with guard + branch + a non-blank sale number", () => {
    stubSearch(() => ({ status: 200, body: {} }));
    mount();
    expect(searchButton()).toBeDisabled();
    typeSale("   ");
    expect(searchButton()).toBeDisabled();
    typeSale(" T-1 ");
    expect(searchButton()).toBeEnabled();
  });

  it("EW10 clicking search issues exactly one GET with branchId and the trimmed sale number", async () => {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "2", "0", "2")]) }));
    mount();
    typeSale("  T-1 ");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    expect(gets).toHaveLength(1);
    const url = new URL(gets[0]);
    expect(url.pathname).toMatch(/\/sales\/exchangeable$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ branchId: "b1", saleNumber: "T-1" });
  });

  it("EW11 while searching the phase is SEARCHING_SALE and the button is disabled", async () => {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "2", "0", "2")]) }), true);
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SEARCHING_SALE"));
    expect(searchButton()).toBeDisabled();
    await letGo();
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
  });

  it("EW12 a valid answer reaches the store raw: userId, branchId, saleNumber and the untouched body", async () => {
    const body = readBody([row(ITEM_A, "2", "0", "2")]);
    stubSearch(() => ({ status: 200, body }));
    const spy = vi.spyOn(exchangeDrafts, "openDraftFromFreshRead");
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ userId: "u1", branchId: "b1", saleNumber: "T-1", read: body });
  });

  it("EW13 when the store accepts the read the phase is SALE_LOADED and the sale and its lines are shown", async () => {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "5", "2", "3", "SKU-A"), row(ITEM_B, "1", "0", "1", "SKU-B")]) }));
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    expect(screen.getByText("T-1")).toBeInTheDocument();
    expect(screen.getByText("Sucursal").nextElementSibling).toHaveTextContent("Centro (CE)");
    expect(screen.getByText(/RETAIL/)).toBeInTheDocument();
    expect(screen.getByText(/LIST/)).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    for (const text of [ITEM_A, "Remera", "Negro / M", "SKU-A", "5", "2", "3", "12.500"]) expect(rows[0]).toHaveTextContent(text);
    expect(exchangeDrafts.getDraft("u1", SALE_ID)).toBeTruthy();
  });

  it("EW14 a line with remainingQuantity 0 is shown but marked as not exchangeable", async () => {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "2", "2", "0", "SKU-A"), row(ITEM_B, "1", "0", "1", "SKU-B")]) }));
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    const [spent, open] = screen.getAllByRole("row").slice(1);
    expect(spent).toHaveTextContent("SKU-A");
    expect(spent).toHaveTextContent(/agotada|sin cambio/i);
    expect(open).not.toHaveTextContent(/agotada|sin cambio/i);
  });

  it("EW15 NOTHING_LEFT_TO_EXCHANGE gives an operational message and the phase is not SALE_LOADED", async () => {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "2", "2", "0")]) }));
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/no queda ninguna prenda|nada para cambiar/i);
    expect(phase()).toBe("SEARCH_ERROR");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("EW16 NOT_EXCHANGEABLE gives a message and does not render the sale", async () => {
    const body = { ...readBody([row(ITEM_A, "2", "0", "2")]), exchangeable: false };
    stubSearch(() => ({ status: 200, body }));
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no admite cambios/i);
    expect(alert).not.toHaveTextContent(/COMPLETED|RETAIL|SKU|1250000/);
    expect(phase()).toBe("SEARCH_ERROR");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it.each([
    ["READ_INVALID", () => ({ nope: true }), /respuesta.*no es válida/i],
    ["READ_MISMATCH", () => readBody([row(ITEM_A, "2", "0", "2")], "b1", "OTRA"), /no corresponde/i],
    ["READ_STALE", null, /desactualizada/i],
  ])("EW17 %s shows a clear error and opens no editable flow", async (reason, make, message) => {
    stubSearch(() => ({ status: 200, body: make ? make() : readBody([row(ITEM_A, "2", "0", "2")]) }));
    if (!make) vi.spyOn(exchangeDrafts, "openDraftFromFreshRead").mockResolvedValue({ ok: false, reason: reason as "READ_STALE" });
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(phase()).toBe("SEARCH_ERROR");
    expect(screen.queryByRole("table")).toBeNull();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)).toBeFalsy();
  });

  it("EW18 PERSIST_FAILED reports a storage problem and does not continue", async () => {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "2", "0", "2")]) }));
    vi.spyOn(exchangeDrafts, "openDraftFromFreshRead").mockResolvedValue({ ok: false, reason: "PERSIST_FAILED" });
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/almacenamiento/i);
    expect(phase()).toBe("SEARCH_ERROR");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("EW19 a 401 calls onSessionExpired once and opens no draft", async () => {
    stubSearch(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Se requiere autenticación." } } }));
    const spy = vi.spyOn(exchangeDrafts, "openDraftFromFreshRead");
    const expired = mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  async function loaded() {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "2", "0", "2")]) }));
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
  }

  it("EW20 changing the branch after loading goes back to IDLE without wiping persisted drafts", async () => {
    await loaded();
    const clear = vi.spyOn(exchangeDrafts, "clearAll");
    fireEvent.change(screen.getByRole("combobox", { name: /Sucursal autorizada/ }), { target: { value: "b2" } });
    expect(phase()).toBe("IDLE");
    expect(screen.queryByRole("table")).toBeNull();
    expect(clear).not.toHaveBeenCalled();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)).toBeTruthy();
  });

  it("EW21 changing the sale number after loading goes back to IDLE without wiping persisted drafts", async () => {
    await loaded();
    const clear = vi.spyOn(exchangeDrafts, "clearAll");
    typeSale("T-2");
    expect(phase()).toBe("IDLE");
    expect(screen.queryByRole("table")).toBeNull();
    expect(clear).not.toHaveBeenCalled();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)).toBeTruthy();
  });

  it("EW22 a double click sends a single request", async () => {
    stubSearch(() => ({ status: 200, body: readBody([row(ITEM_A, "2", "0", "2")]) }), true);
    mount();
    typeSale("T-1");
    fireEvent.click(searchButton());
    fireEvent.click(searchButton());
    await letGo();
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    expect(gets).toHaveLength(1);
  });
});

// UI-3: original line + quantity + replacement search and choice. PRE-REGISTERED EXPECTATIONS: EW23..EW41.
//   - only lines with remainingQuantity > 0 can be chosen; quantity is a canonical positive integer <= remaining, validated with BigInt;
//   - GET /sales/:saleId/exchange-replacements?branchId&saleItemId&search&page&limit; one request per submit; a stale answer is dropped;
//   - the endpoint's `comparison` is the only price judgement: only EQUAL with available >= returnQuantity can be chosen, the rest is
//     shown disabled with the reason;
//   - choosing writes the draft through exchangeDrafts.edit (`line`: the opening read already created the line; addLine only if it is missing);
//     a quantity that no longer fits deselects by resetting that line to its opened state (replacement null, no quantity).
const VAR_1 = "var-1";
const VAR_2 = "var-2";
type Cand = { id: string; sku: string; comparison: string; available: string; replacementUnitPrice: string; color?: string | null; size?: string | null; name?: string };
const cand = (id: string, sku: string, comparison: string, available: string, replacementUnitPrice = "1250000", color: string | null = "Rojo", size: string | null = "L", name = "Buzo"): Cand =>
  ({ id, sku, comparison, available, replacementUnitPrice, color, size, name });
const repBody = (items: Cand[], original = "1250000") => ({
  sale: { id: SALE_ID, saleNumber: "T-1", branchId: "b1", pricingMode: "LIST", priceMode: "CASH" },
  saleItem: { id: ITEM_A, variantId: "variant-2", originalUnitPrice: original },
  items: items.map((c) => ({ id: c.id, productId: "p", sku: c.sku, barcode: null, color: c.color, size: c.size, product: { id: "p", name: c.name }, available: c.available, replacementUnitPrice: c.replacementUnitPrice, comparison: c.comparison })),
  pagination: { page: 1, limit: 20, total: items.length },
});

let repUrls: string[] = [];
let repHold: Array<() => void> = [];
const DEFAULT_ROWS = [row(ITEM_A, "5", "0", "5", "SKU-A"), row(ITEM_B, "3", "3", "0", "SKU-B")];
const configured = () => exchangeDrafts.getDraft("u1", SALE_ID)!.lines.filter((line) => line.replacementVariantId !== null);
function stubFlow(rowsIn: Row[], replacements: (url: URL) => { status: number; body: unknown }, hold = false) {
  const rows = rowsIn.length > 0 ? rowsIn : DEFAULT_ROWS;
  repUrls = [];
  repHold = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/sales/exchangeable")) return json(readBody(rows));
    repUrls.push(url.toString());
    const answer = replacements(url);
    // the endpoint answers for the line it was asked about
    const asked = url.searchParams.get("saleItemId");
    if (answer.status === 200 && asked) (answer.body as ReturnType<typeof repBody>).saleItem.id = asked;
    if (hold) await new Promise<void>((resolve) => repHold.push(resolve));
    return json(answer.body, answer.status);
  }));
}
const repPhase = () => document.querySelector("[data-replacement-phase]")!.getAttribute("data-replacement-phase");
const rowOf = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;
async function openSale(rows = [row(ITEM_A, "5", "0", "5", "SKU-A"), row(ITEM_B, "3", "3", "0", "SKU-B")]) {
  render(<ExchangeWorkspace {...WHO} onSessionExpired={onExpired} />);
  typeSale("T-1");
  fireEvent.click(searchButton());
  await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
  return rows;
}
let onExpired = vi.fn();
const chooseLine = (id: string) => fireEvent.click(within(rowOf(id)).getByRole("button", { name: /Elegir prenda/ }));
const qtyInput = () => screen.getByLabelText(/Cantidad a devolver/) as HTMLInputElement;
const setQty = (value: string) => fireEvent.change(qtyInput(), { target: { value } });
const typeSearch = (value: string) => fireEvent.change(screen.getByLabelText(/Buscar reemplazo/), { target: { value } });
const submitReplacements = () => fireEvent.click(screen.getByRole("button", { name: /Buscar reemplazos/ }));
const candButton = (sku: string) => within(rowOf(sku)).getByRole("button", { name: /Elegir reemplazo/ });
async function withCandidates(items: Cand[], qty = "1", rows?: Row[]) {
  stubFlow(rows ?? [row(ITEM_A, "5", "0", "5", "SKU-A"), row(ITEM_B, "3", "3", "0", "SKU-B")], () => ({ status: 200, body: repBody(items) }));
  await openSale();
  chooseLine(ITEM_A);
  if (qty !== "1") setQty(qty);
  submitReplacements();
  await waitFor(() => expect(repPhase()).toBe("REPLACEMENTS_LOADED"));
}

describe("ExchangeWorkspace UI-3 — original line, quantity and replacement", () => {
  beforeEach(() => {
    window.localStorage.clear();
    onExpired = vi.fn();
    Object.defineProperty(navigator, "locks", { value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() }, configurable: true });
    exchangeDrafts.clearAll();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "locks");
  });

  it("EW23 a line with remaining > 0 can be chosen; a spent line offers no choice", async () => {
    stubFlow([], () => ({ status: 200, body: repBody([]) }));
    await openSale();
    expect(within(rowOf(ITEM_A)).getByRole("button", { name: /Elegir prenda/ })).toBeEnabled();
    expect(within(rowOf(ITEM_B)).queryByRole("button", { name: /Elegir prenda/ })).toBeNull();
    expect(repPhase()).toBe("REPLACEMENT_IDLE");
  });

  it("EW24 choosing a line starts the quantity at 1", async () => {
    stubFlow([], () => ({ status: 200, body: repBody([]) }));
    await openSale();
    chooseLine(ITEM_A);
    expect(qtyInput().value).toBe("1");
  });

  it.each(["0", "-1", "1.5", "abc", "", "6", "01", " 2"])("EW25 quantity %j is refused and nothing is searched", async (bad) => {
    stubFlow([], () => ({ status: 200, body: repBody([]) }));
    await openSale();
    chooseLine(ITEM_A);
    setQty(bad);
    expect(screen.getByRole("alert")).toHaveTextContent(/cantidad/i);
    expect(screen.getByRole("button", { name: /Buscar reemplazos/ })).toBeDisabled();
    setQty("5");
    expect(screen.queryByText(/cantidad.*(inválida|entre)/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Buscar reemplazos/ })).toBeEnabled();
  });

  it("EW26 searches with the exact URL: saleId, branchId, saleItemId and the trimmed search", async () => {
    stubFlow([], () => ({ status: 200, body: repBody([]) }));
    await openSale();
    chooseLine(ITEM_A);
    typeSearch("  buzo  ");
    submitReplacements();
    await waitFor(() => expect(repUrls).toHaveLength(1));
    const url = new URL(repUrls[0]);
    expect(url.pathname).toMatch(new RegExp(`/sales/${SALE_ID}/exchange-replacements$`));
    expect(Object.fromEntries(url.searchParams)).toEqual({ branchId: "b1", saleItemId: ITEM_A, search: "buzo", page: "1", limit: "20" });
  });

  it("EW26b an empty search omits the parameter", async () => {
    stubFlow([], () => ({ status: 200, body: repBody([]) }));
    await openSale();
    chooseLine(ITEM_A);
    typeSearch("   ");
    submitReplacements();
    await waitFor(() => expect(repUrls).toHaveLength(1));
    expect(new URL(repUrls[0]).searchParams.has("search")).toBe(false);
  });

  it("EW27 while searching the phase is SEARCHING_REPLACEMENTS and a second submit sends nothing", async () => {
    stubFlow([], () => ({ status: 200, body: repBody([]) }), true);
    await openSale();
    chooseLine(ITEM_A);
    submitReplacements();
    await waitFor(() => expect(repPhase()).toBe("SEARCHING_REPLACEMENTS"));
    expect(screen.getByRole("button", { name: /Buscar reemplazos/ })).toBeDisabled();
    submitReplacements();
    submitReplacements();
    await waitFor(() => expect(repHold).toHaveLength(1));
    repHold[0]();
    await waitFor(() => expect(repPhase()).toBe("REPLACEMENTS_LOADED"));
    expect(repUrls).toHaveLength(1);
  });

  it("EW28 renders EQUAL, CHEAPER and MORE_EXPENSIVE with product, SKU, color, size, stock and both prices", async () => {
    await withCandidates([
      cand(VAR_1, "SKU-EQ", "EQUAL", "7", "1250000", "Rojo", "L", "Buzo"),
      cand("v3", "SKU-CH", "CHEAPER", "9", "1000000"),
      cand("v4", "SKU-MX", "MORE_EXPENSIVE", "9", "1500000"),
    ]);
    const eq = rowOf("SKU-EQ");
    for (const text of ["Buzo", "Rojo", "L", "7", "12.500"]) expect(eq).toHaveTextContent(text);
    expect(rowOf("SKU-CH")).toHaveTextContent("10.000");
    expect(rowOf("SKU-MX")).toHaveTextContent("15.000");
    expect(screen.getByText(/Precio de la prenda original/)).toHaveTextContent("12.500");
  });

  it("EW29 a CHEAPER candidate is visible, disabled and says why", async () => {
    await withCandidates([cand("v3", "SKU-CH", "CHEAPER", "9", "1000000")]);
    expect(candButton("SKU-CH")).toBeDisabled();
    expect(rowOf("SKU-CH")).toHaveTextContent("Es más barata que la prenda original.");
  });

  it("EW30 a MORE_EXPENSIVE candidate is visible, disabled and says why", async () => {
    await withCandidates([cand("v4", "SKU-MX", "MORE_EXPENSIVE", "9", "1500000")]);
    expect(candButton("SKU-MX")).toBeDisabled();
    expect(rowOf("SKU-MX")).toHaveTextContent("Es más cara que la prenda original.");
  });

  it("EW31 an EQUAL candidate with available 0 is disabled", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "0")]);
    expect(candButton("SKU-EQ")).toBeDisabled();
    expect(rowOf("SKU-EQ")).toHaveTextContent("Sin stock suficiente en esta sucursal.");
  });

  it("EW32 an EQUAL candidate with available below the quantity is disabled", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "2")], "3");
    expect(candButton("SKU-EQ")).toBeDisabled();
    expect(rowOf("SKU-EQ")).toHaveTextContent("Sin stock suficiente en esta sucursal.");
  });

  it("EW33 an EQUAL candidate with enough stock can be chosen", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "3")], "3");
    expect(candButton("SKU-EQ")).toBeEnabled();
  });

  it("EW34 choosing a candidate writes the draft with the exact `line` payload (the line already exists from the opening read)", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "3", "1250000", "Rojo", "L", "Buzo")], "2");
    const edit = vi.spyOn(exchangeDrafts, "edit");
    fireEvent.click(candButton("SKU-EQ"));
    expect(edit.mock.calls).toEqual([
      ["u1", SALE_ID, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_1, replacementLabel: "Buzo · Rojo · L · SKU-EQ", returnQuantity: "2" }],
    ]);
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.lines).toEqual([
      expect.objectContaining({ saleItemId: ITEM_A, replacementVariantId: VAR_1, returnQuantity: "2" }),
    ]);
    expect(candButton("SKU-EQ")).toHaveAttribute("aria-pressed", "true");
  });

  it("EW34b a candidate without color or size gets a label without holes", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "3", "1250000", null, null, "Buzo")]);
    const edit = vi.spyOn(exchangeDrafts, "edit");
    fireEvent.click(candButton("SKU-EQ"));
    expect(edit).toHaveBeenLastCalledWith("u1", SALE_ID, expect.objectContaining({ replacementLabel: "Buzo · SKU-EQ" }));
  });

  it("EW35 changing the quantity updates the persisted line while the candidate still fits", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "4")]);
    fireEvent.click(candButton("SKU-EQ"));
    const edit = vi.spyOn(exchangeDrafts, "edit");
    setQty("3");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("u1", SALE_ID, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_1, replacementLabel: "Buzo · Rojo · L · SKU-EQ", returnQuantity: "3" });
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.lines[0].returnQuantity).toBe("3");
    expect(candButton("SKU-EQ")).toHaveAttribute("aria-pressed", "true");
  });

  it("EW36 a quantity above the available stock deselects the candidate and resets the persisted line", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "2")]);
    fireEvent.click(candButton("SKU-EQ"));
    expect(configured()).toHaveLength(1);
    const edit = vi.spyOn(exchangeDrafts, "edit");
    setQty("3");
    expect(edit).toHaveBeenCalledWith("u1", SALE_ID, { type: "line", saleItemId: ITEM_A, replacementVariantId: null, replacementLabel: "", returnQuantity: "" });
    expect(configured()).toEqual([]);
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.lines).toHaveLength(1); // the line itself stays, as the opening read made it
    expect(candButton("SKU-EQ")).toBeDisabled();
    expect(candButton("SKU-EQ")).toHaveAttribute("aria-pressed", "false");
  });

  it("EW36b an invalid quantity also deselects and resets the persisted line", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "9")]);
    fireEvent.click(candButton("SKU-EQ"));
    setQty("0");
    expect(configured()).toEqual([]);
  });

  it("EW37 choosing another line discards the previous results and keeps the first line's draft entry", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "9")], "1", [row(ITEM_A, "5", "0", "5", "SKU-A"), row(ITEM_B, "3", "0", "3", "SKU-B")]);
    fireEvent.click(candButton("SKU-EQ"));
    chooseLine(ITEM_B);
    expect(repPhase()).toBe("REPLACEMENT_IDLE");
    expect(screen.queryByText("SKU-EQ")).toBeNull();
    expect(configured().map((line) => line.saleItemId)).toEqual([ITEM_A]);
  });

  it("EW38 a late answer of an earlier search never overwrites the newer one", async () => {
    let n = 0;
    stubFlow([row(ITEM_A, "5", "0", "5", "SKU-A"), row(ITEM_B, "3", "0", "3", "SKU-B")], () => ({
      status: 200, body: repBody([cand(`v${++n}`, n === 1 ? "SKU-OLD" : "SKU-NEW", "EQUAL", "9")]),
    }), true);
    await openSale();
    chooseLine(ITEM_A);
    submitReplacements();
    await waitFor(() => expect(repHold).toHaveLength(1));
    chooseLine(ITEM_B);
    submitReplacements();
    await waitFor(() => expect(repHold).toHaveLength(2));
    repHold[1]();
    await screen.findByText("SKU-NEW");
    repHold[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("SKU-OLD")).toBeNull();
    expect(screen.getByText("SKU-NEW")).toBeInTheDocument();
    expect(repPhase()).toBe("REPLACEMENTS_LOADED");
  });

  it("EW39 a 401 on the replacements calls onSessionExpired once and touches no draft", async () => {
    stubFlow([], () => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Se requiere autenticación." } } }));
    await openSale();
    const edit = vi.spyOn(exchangeDrafts, "edit");
    chooseLine(ITEM_A);
    submitReplacements();
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    expect(edit).not.toHaveBeenCalled();
  });

  it("EW40 an HTTP error shows the message and leaves the draft alone", async () => {
    stubFlow([], () => ({ status: 409, body: { error: { code: "INVALID_SALE_STATE", message: "La venta no puede cambiarse en su estado actual." } } }));
    await openSale();
    const edit = vi.spyOn(exchangeDrafts, "edit");
    chooseLine(ITEM_A);
    submitReplacements();
    await waitFor(() => expect(repPhase()).toBe("REPLACEMENTS_ERROR"));
    expect(screen.getByRole("alert")).toHaveTextContent("La venta no puede cambiarse en su estado actual.");
    expect(edit).not.toHaveBeenCalled();
    expect(configured()).toEqual([]);
  });

  it("EW40b a malformed body is an error, not a list", async () => {
    stubFlow([], () => ({ status: 200, body: { items: [{ id: "x", comparison: "EQUAL" }] } }));
    await openSale();
    chooseLine(ITEM_A);
    submitReplacements();
    await waitFor(() => expect(repPhase()).toBe("REPLACEMENTS_ERROR"));
  });

  it("EW41 stock, quantity and prices beyond 2^53 are compared and shown exactly", async () => {
    const big = "9007199254740993"; // 2^53 + 1: Number() would read it as 2^53
    const below = "9007199254740992";
    const rows = [row(ITEM_A, big, "0", big, "SKU-A")];
    await withCandidates([cand(VAR_1, "SKU-LOW", "EQUAL", below, "9007199254740993"), cand(VAR_2, "SKU-OK", "EQUAL", big, "9007199254740993")], big, rows);
    expect(candButton("SKU-LOW")).toBeDisabled();
    expect(candButton("SKU-OK")).toBeEnabled();
    expect(rowOf("SKU-OK")).toHaveTextContent("90.071.992.547.409,93");
    expect(qtyInput().value).toBe(big);
    setQty("9007199254740994"); // remaining + 1: refused even though Number() could not tell
    expect(screen.getByRole("alert")).toHaveTextContent(/cantidad/i);
  });

  it("EW42 changing the sale number clears the replacement state too", async () => {
    await withCandidates([cand(VAR_1, "SKU-EQ", "EQUAL", "9")]);
    typeSale("T-2");
    expect(repPhase()).toBe("REPLACEMENT_IDLE");
    expect(screen.queryByText("SKU-EQ")).toBeNull();
    expect(screen.queryByLabelText(/Cantidad a devolver/)).toBeNull();
  });
});

// UI-4: reason + send + the states of the draft + reconciliation. PRE-REGISTERED EXPECTATIONS: EW43..EW70. Read from exchange-draft-store.ts:
//   - send() builds the payload with canonicalPayloadOf: EVERY line of the draft must be complete, otherwise INCOMPLETE. Lines without a
//     replacement are NOT omitted; the screen offers "Quitar líneas sin reemplazo" (removeLine) and enables Confirmar by the store's own
//     canonicalPayloadOf, never by a second rule;
//   - reconcileAfterFreshRead performs its OWN GET /sales/exchangeable (token in, no read argument): the screen never fetches twice;
//   - UNCERTAIN has no way out but the same payload with the same key through send(): offered ONLY as an explicit "Verificar el cambio".
const VAR_UUID = "44444444-4444-4444-8444-444444444444";
// A confirmed attempt is persisted as a tombstone, and the store only reads back a UUID exchange id.
const EX_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const EX_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const EX_9 = "aaaaaaaa-0000-4000-8000-000000000009";
const EX_777 = "aaaaaaaa-0000-4000-8000-000000000777";
type PostAnswer = { status: number; body: unknown };
let posts: Array<{ url: string; body: { reason: string; idempotencyKey: string; lines: Array<Record<string, string>> } }> = [];
let postHold: Array<() => void> = [];
let exchangeableReads = 0;

type Flow = {
  rows?: Row[];
  post?: () => PostAnswer;
  holdPost?: boolean;
  reads?: (n: number) => { status: number; body: unknown }; // n = 1 for the first GET /sales/exchangeable
};
function stubExchangeFlow(flow: Flow = {}) {
  posts = [];
  postHold = [];
  exchangeableReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/sales/exchangeable")) {
      exchangeableReads += 1;
      const custom = flow.reads?.(exchangeableReads);
      if (custom) return json(custom.body, custom.status);
      // once an exchange was posted, the server's read shows it: one more unit of item A exchanged
      const base = flow.rows ?? [row(ITEM_A, "5", "0", "5", "SKU-A"), row(ITEM_B, "3", "3", "0", "SKU-B")];
      const after = base.map((r) => (r.saleItemId === ITEM_A && posts.length > 0 ? row(r.saleItemId, r.quantity, String(BigInt(r.exchangedQuantity) + BigInt(1)), String(BigInt(r.remainingQuantity) - BigInt(1)), r.sku) : r));
      return json(readBody(after));
    }
    if (url.pathname.endsWith("/exchange-replacements")) {
      const body = repBody([cand(VAR_UUID, "SKU-EQ", "EQUAL", "9")]);
      body.saleItem.id = url.searchParams.get("saleItemId")!;
      return json(body);
    }
    if (url.pathname.endsWith("/exchanges")) {
      posts.push({ url: url.pathname, body: JSON.parse(String(init?.body)) });
      if (flow.holdPost) await new Promise<void>((resolve) => postHold.push(resolve));
      const answer = flow.post?.() ?? { status: 201, body: { exchangeId: EX_1, replayed: false } };
      return json(answer.body, answer.status);
    }
    return json({ items: [] });
  }));
}
const reasonInput = () => screen.getByLabelText(/Motivo del cambio/) as HTMLInputElement;
const typeReason = (value: string) => fireEvent.change(reasonInput(), { target: { value } });
const confirmButton = () => screen.queryByRole("button", { name: /Confirmar cambio/ }) as HTMLButtonElement | null;
const err = (status: number, code: string, message = "msg") => ({ status, body: { error: { code, message } } });
const durableKeys = () => Object.keys(window.localStorage).filter((key) => key.startsWith(ATTEMPT_KEY_PREFIX));

// Mount, load the sale, choose the line + the replacement (what UI-3 does) and type a reason.
async function readyToConfirm(reason = "Talle incorrecto") {
  render(<ExchangeWorkspace {...WHO} onSessionExpired={onExpired} />);
  typeSale("T-1");
  fireEvent.click(searchButton());
  await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
  chooseLine(ITEM_A);
  submitReplacements();
  await waitFor(() => expect(repPhase()).toBe("REPLACEMENTS_LOADED"));
  fireEvent.click(candButton("SKU-EQ"));
  if (reason) typeReason(reason);
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("ExchangeWorkspace UI-4 — reason, send, draft states and reconciliation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    onExpired = vi.fn();
    Object.defineProperty(navigator, "locks", { value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() }, configurable: true });
    exchangeDrafts.clearAll();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "locks");
  });

  it("EW43 an empty or blank reason does not enable Confirmar cambio", async () => {
    stubExchangeFlow();
    await readyToConfirm("");
    expect(confirmButton()).toBeDisabled();
    typeReason("     ");
    expect(confirmButton()).toBeDisabled();
  });

  it("EW43b a disabled Confirmar cambio says why, and the hint is tied to the button for assistive technology", async () => {
    stubExchangeFlow();
    await readyToConfirm("");
    const hint = screen.getByText("Escribí el motivo del cambio para poder confirmar.");
    expect(confirmButton()).toHaveAttribute("aria-describedby", hint.id);
    typeReason("Talle");
    expect(screen.queryByText("Escribí el motivo del cambio para poder confirmar.")).toBeNull();
    expect(confirmButton()).not.toHaveAttribute("aria-describedby");
  });

  it("EW44 a valid reason is persisted in the draft through exchangeDrafts.edit", async () => {
    stubExchangeFlow();
    await readyToConfirm("");
    const edit = vi.spyOn(exchangeDrafts, "edit");
    typeReason("Talle chico");
    expect(edit).toHaveBeenCalledWith("u1", SALE_ID, { type: "reason", value: "Talle chico" });
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.reason).toBe("Talle chico");
    expect(screen.getByText("11/200")).toBeInTheDocument();
  });

  it("EW45 a reason over 200 characters is not persisted, says so, and cannot be confirmed", async () => {
    stubExchangeFlow();
    await readyToConfirm("Motivo previo");
    const edit = vi.spyOn(exchangeDrafts, "edit");
    typeReason("x".repeat(201));
    expect(edit).not.toHaveBeenCalled();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.reason).toBe("Motivo previo");
    expect(screen.getByText(/201\/200/)).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled(); // never sends the OLD reason while the screen shows another text
    typeReason("x".repeat(200));
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.reason).toBe("x".repeat(200));
    expect(confirmButton()).toBeEnabled();
  });

  it("EW46 without any configured line there is nothing to confirm, even with a reason", async () => {
    stubExchangeFlow();
    render(<ExchangeWorkspace {...WHO} onSessionExpired={onExpired} />);
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    typeReason("Motivo");
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(/Elegí el reemplazo/)).toBeInTheDocument();
  });

  it("EW47 with a complete draft Confirmar cambio is enabled", async () => {
    stubExchangeFlow();
    await readyToConfirm();
    expect(confirmButton()).toBeEnabled();
  });

  it("EW48 confirming calls exchangeDrafts.send once with userId, saleId and token, and posts the trimmed reason", async () => {
    stubExchangeFlow();
    await readyToConfirm("  Talle incorrecto  ");
    const send = vi.spyOn(exchangeDrafts, "send");
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ userId: "u1", saleId: SALE_ID, token: "tok" });
    expect(posts[0].url).toMatch(new RegExp(`/sales/${SALE_ID}/exchanges$`));
    expect(posts[0].body.reason).toBe("Talle incorrecto");
    expect(posts[0].body.lines).toEqual([{ saleItemId: ITEM_A, replacementVariantId: VAR_UUID, returnQuantity: "1" }]);
    await settled();
  });

  it("EW49 a double click sends once", async () => {
    stubExchangeFlow({ holdPost: true });
    await readyToConfirm();
    const send = vi.spyOn(exchangeDrafts, "send");
    // both clicks inside ONE batch: React has not re-rendered (so the button is not disabled yet) when the second one arrives
    const button = confirmButton()!;
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(postHold).toHaveLength(1));
    expect(send).toHaveBeenCalledTimes(1);
    postHold[0]();
    await screen.findByText(/Cambio confirmado/);
    expect(posts).toHaveLength(1);
  });

  it("EW50 while SENDING the screen says so and freezes every control", async () => {
    stubExchangeFlow({ holdPost: true });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(postHold).toHaveLength(1));
    expect(screen.getByRole("status")).toHaveTextContent(/Procesando|Enviando/);
    expect(confirmButton()).toBeDisabled();
    expect(reasonInput()).toBeDisabled();
    expect(qtyInput()).toBeDisabled();
    expect(screen.getByLabelText(/Número de venta/)).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Sucursal autorizada/ })).toBeDisabled();
    expect(candButton("SKU-EQ")).toBeDisabled();
    expect(within(rowOf(ITEM_A)).getByRole("button", { name: /Elegir prenda/ })).toBeDisabled();
    postHold[0]();
    await screen.findByText(/Cambio confirmado/);
  });

  it("EW51 REJECTED says nothing was registered, and the draft can be corrected and sent again", async () => {
    let n = 0;
    stubExchangeFlow({ post: () => (++n === 1 ? err(409, "NO_OP_EXCHANGE") : { status: 201, body: { exchangeId: EX_2, replayed: false } }) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No se pudo hacer el cambio. No se registró nada.");
    expect(alert).toHaveTextContent("NO_OP_EXCHANGE");
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.attempt!.status).toBe("REJECTED");
    expect(durableKeys()).toEqual([]);
    expect(reasonInput()).toBeEnabled();
    typeReason("Otro motivo");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.attempt).toBeNull();
    fireEvent.click(confirmButton()!);
    await screen.findByText(/Cambio confirmado/);
    expect(posts).toHaveLength(2);
    expect(posts[1].body.idempotencyKey).not.toBe(posts[0].body.idempotencyKey); // the STORE minted it: a definitive rejection is a new intent
  });

  it("EW52 INSUFFICIENT_STOCK has its own message", async () => {
    stubExchangeFlow({ post: () => err(409, "INSUFFICIENT_STOCK") });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    expect(await screen.findByRole("alert")).toHaveTextContent("No hay stock suficiente del reemplazo en esta sucursal.");
  });

  it.each([
    ["REPLACEMENT_CHEAPER_NOT_SUPPORTED", /más barato/],
    ["REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED", /más caro/],
    ["EXCHANGE_QUANTITY_EXCEEDED", /supera lo que queda/],
    ["SALE_ITEM_MISMATCH", /no pertenece a esta venta/],
    ["INVALID_SALE_STATE", /estado actual/],
    ["IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", /otro contenido/],
    ["SALE_EXCHANGE_STOCK_INCONSISTENT", /inconsistente/],
  ])("EW53 %s has a specific message and keeps its code visible", async (code, message) => {
    stubExchangeFlow({ post: () => err(409, code) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(code);
  });

  it("EW54 UNCERTAIN is not 'failed': it says the outcome is unknown, freezes the draft and offers no new confirmation", async () => {
    stubExchangeFlow({ post: () => err(500, "INTERNAL", "boom") });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No pudimos confirmar si el cambio se registró");
    expect(alert).not.toHaveTextContent(/falló|No se registró nada/);
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.attempt!.status).toBe("UNCERTAIN");
    expect(confirmButton()).toBeNull();
    expect(reasonInput()).toBeDisabled();
    expect(qtyInput()).toBeDisabled();
    expect(candButton("SKU-EQ")).toBeDisabled();
    expect(durableKeys()).toHaveLength(1);
  });

  it("EW55 UNCERTAIN never retries by itself; only the explicit verification replays the SAME key and body", async () => {
    let n = 0;
    stubExchangeFlow({ post: () => (++n === 1 ? err(500, "INTERNAL") : { status: 200, body: { exchangeId: EX_9, replayed: true } }) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await screen.findByRole("alert");
    await settled();
    expect(posts).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Verificar el cambio/ }));
    await screen.findByText(/Cambio confirmado/);
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual(posts[0].body); // same idempotencyKey, same payload
  });

  it("EW56 UNCERTAIN + expired session calls onSessionExpired and keeps the unresolved attempt in memory and storage", async () => {
    stubExchangeFlow({ post: () => err(401, "UNAUTHORIZED", "Token") });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.attempt!.status).toBe("UNCERTAIN");
    expect(durableKeys()).toHaveLength(1);
    exchangeDrafts.dropEditable(); // what the page's logout does
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.attempt!.status).toBe("UNCERTAIN");
  });

  it("EW57 CONFIRMED shows the success and the exchange id", async () => {
    stubExchangeFlow({ post: () => ({ status: 201, body: { exchangeId: EX_777, replayed: false } }) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    const status = await screen.findByText(/Cambio confirmado/);
    expect(status.closest("[role=status]")).toHaveTextContent(EX_777);
  });

  it("EW58 a replayed CONFIRMED is explained, not shown as a duplicate or an error", async () => {
    stubExchangeFlow({ post: () => ({ status: 200, body: { exchangeId: EX_777, replayed: true } }) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    const status = (await screen.findByText(/Cambio confirmado/)).closest("[role=status]")!;
    expect(status).toHaveTextContent(/ya estaba registrado/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("EW59 after CONFIRMED a second send is impossible while the sale could not be refreshed", async () => {
    stubExchangeFlow({ reads: (n) => (n === 1 ? { status: 200, body: readBody([row(ITEM_A, "5", "0", "5", "SKU-A")]) } : err(500, "INTERNAL")) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await screen.findByText(/no pudimos actualizar la venta/);
    expect(confirmButton()).toBeNull();
    const send = vi.spyOn(exchangeDrafts, "send");
    await expect(exchangeDrafts.send({ userId: "u1", saleId: SALE_ID, token: "tok" })).rejects.toMatchObject({ code: "CONFIRMED_REQUIRES_REFRESH" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
  });

  it("EW60 after CONFIRMED the store reconciles with its own GET /sales/exchangeable (branch + sale number) and nothing is posted again", async () => {
    stubExchangeFlow();
    const reconcile = vi.spyOn(exchangeDrafts, "reconcileAfterFreshRead");
    await readyToConfirm();
    const readsBefore = exchangeableReads;
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile).toHaveBeenCalledWith({ userId: "u1", saleId: SALE_ID, branchId: "b1", saleNumber: "T-1", token: "tok" });
    await waitFor(() => expect(exchangeableReads).toBe(readsBefore + 1)); // exactly ONE extra GET: the store's, not a second one of the screen
    await settled();
    expect(exchangeableReads).toBe(readsBefore + 1);
    expect(posts).toHaveLength(1);
  });

  it("EW61 a successful reconciliation closes the tombstone, opens a clean draft and shows the new remainder", async () => {
    stubExchangeFlow({ reads: (n) => ({ status: 200, body: readBody(n === 1 ? [row(ITEM_A, "5", "0", "5", "SKU-A")] : [row(ITEM_A, "5", "1", "4", "SKU-A")]) }) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(within(rowOf(ITEM_A)).getByText("4")).toBeInTheDocument());
    const draft = exchangeDrafts.getDraft("u1", SALE_ID)!;
    expect(draft.attempt).toBeNull();
    expect(draft.recovery).toBeNull();
    expect(draft.reason).toBe("");
    expect(durableKeys()).toEqual([]);
    expect(screen.getByText(/Cambio confirmado/)).toBeInTheDocument(); // the success stays visible
    expect(confirmButton()).toBeDisabled(); // a NEW exchange needs its own replacement and reason
    expect(reasonInput()).toBeEnabled();
  });

  it("F01-12/14 confirming the LAST remainder: Cambio confirmado, the reconcile ends well, no error, no pending CONFIRMED, no draft, no summary, no Confirmar, one POST; a new search still works", async () => {
    stubExchangeFlow({ rows: [row(ITEM_A, "1", "0", "1", "SKU-A")] });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(exchangeDrafts.getDraft("u1", SALE_ID)).toBeNull());
    await settled();
    expect(screen.getByText(/Cambio confirmado/).closest("[role=status]")).toHaveTextContent(/La venta ya está actualizada/);
    expect(screen.queryByText(/no pudimos actualizar la venta/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Actualizar venta/ })).toBeNull();
    expect(screen.queryByText("Resumen del cambio")).toBeNull();
    expect(confirmButton()).toBeNull();
    expect(within(rowOf(ITEM_A)).queryByRole("button", { name: /Elegir prenda/ })).toBeNull();
    expect(within(rowOf(ITEM_A)).getByText("Agotada: sin cambio posible")).toBeInTheDocument();
    expect(durableKeys()).toEqual([]);
    expect(posts).toHaveLength(1);
    // the operator can search again as usual
    const readsBefore = exchangeableReads;
    expect(searchButton()).toBeEnabled();
    fireEvent.click(searchButton());
    await waitFor(() => expect(exchangeableReads).toBe(readsBefore + 1));
    expect(posts).toHaveLength(1);
  });

  it("EW62 if the refresh fails AFTER CONFIRMED the screen still says it was confirmed, never 'failed', and never posts again", async () => {
    stubExchangeFlow({ reads: (n) => (n === 1 ? { status: 200, body: readBody([row(ITEM_A, "5", "0", "5", "SKU-A")]) } : err(500, "INTERNAL")) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    const alert = await screen.findByText("El cambio fue confirmado, pero no pudimos actualizar la venta. Volvé a consultar antes de hacer otro cambio.");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/Cambio confirmado/)).toBeInTheDocument();
    expect(screen.queryByText(/No se pudo hacer el cambio/)).toBeNull();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.recovery).toEqual({ reason: "CONFIRMED" });
    await settled();
    expect(posts).toHaveLength(1);
  });

  it("EW62b 'Actualizar venta' retries ONLY the reconciliation and unlocks the sale", async () => {
    stubExchangeFlow({ reads: (n) => (n === 2 ? err(500, "INTERNAL") : { status: 200, body: readBody(n === 1 ? [row(ITEM_A, "5", "0", "5", "SKU-A")] : [row(ITEM_A, "5", "1", "4", "SKU-A")]) }) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    fireEvent.click(await screen.findByRole("button", { name: /Actualizar venta/ }));
    await waitFor(() => expect(exchangeDrafts.getDraft("u1", SALE_ID)!.recovery).toBeNull());
    expect(posts).toHaveLength(1);
  });

  it("EW63 STALE_BASELINE blocks, asks to refresh, and 'Actualizar venta' reconciles instead of resetting", async () => {
    stubExchangeFlow({ reads: (n) => ({ status: 200, body: readBody(n === 1 ? [row(ITEM_A, "5", "0", "5", "SKU-A")] : [row(ITEM_A, "5", "3", "2", "SKU-A")]) }) });
    await readyToConfirm();
    // this client learned (e.g. in another tab) that 3 units of the item were already exchanged: the draft's baseline 0 is now older
    window.localStorage.setItem(markStorageKey("u1", SALE_ID), JSON.stringify({ v: 1, userId: "u1", saleId: SALE_ID, lines: { [ITEM_A]: "3" } }));
    fireEvent.click(confirmButton()!);
    await screen.findByText("La venta cambió desde la última lectura. Volvé a consultarla antes de continuar.");
    expect(posts).toHaveLength(0);
    expect(confirmButton()).toBeNull();
    expect(reasonInput()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Actualizar venta/ }));
    await waitFor(() => expect(exchangeDrafts.getDraft("u1", SALE_ID)!.recovery).toBeNull());
    expect(within(rowOf(ITEM_A)).getByText("2")).toBeInTheDocument();
  });

  it("EW64 RECOVERY_REQUIRED blocks everything, explains it and offers no way to wipe anything", async () => {
    stubExchangeFlow();
    window.localStorage.setItem(attemptStorageKey("u1", SALE_ID), "{not json");
    render(<ExchangeWorkspace {...WHO} onSessionExpired={onExpired} />);
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    expect(screen.getByRole("alert")).toHaveTextContent(/registro local/);
    expect(confirmButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /Actualizar venta|Verificar|Borrar|Limpiar|Descartar/ })).toBeNull();
    expect(within(rowOf(ITEM_A)).getByRole("button", { name: /Elegir prenda/ })).toBeDisabled();
    expect(window.localStorage.getItem(attemptStorageKey("u1", SALE_ID))).toBe("{not json"); // nothing deleted
  });

  it("EW65 RESOLVED_ELSEWHERE does not allow editing the old baseline; refreshing reopens a clean draft", async () => {
    stubExchangeFlow({ post: () => err(500, "INTERNAL"), reads: () => ({ status: 200, body: readBody([row(ITEM_A, "5", "1", "4", "SKU-A")]) }) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await screen.findByRole("alert");
    const key = attemptStorageKey("u1", SALE_ID);
    window.localStorage.removeItem(key); // another tab resolved the attempt and removed the record
    exchangeDrafts.handleStorageEvent(key);
    await screen.findByText(/se resolvió en otra pestaña/);
    expect(confirmButton()).toBeNull();
    expect(reasonInput()).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Verificar el cambio/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Actualizar venta/ }));
    await waitFor(() => expect(exchangeDrafts.getDraft("u1", SALE_ID)!.recovery).toBeNull());
    expect(reasonInput()).toBeEnabled();
  });

  it("EW66 an editable draft survives the workspace being unmounted and can be resumed with its reason and replacement", async () => {
    stubExchangeFlow();
    await readyToConfirm("Talle chico");
    cleanup();
    render(<ExchangeWorkspace {...WHO} onSessionExpired={onExpired} />);
    fireEvent.click(await screen.findByRole("button", { name: /Retomar/ }));
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    expect(reasonInput().value).toBe("Talle chico");
    expect(screen.getByText(/Buzo · Rojo · L · SKU-EQ/)).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("EW69 a 401 while refreshing after CONFIRMED calls onSessionExpired once and keeps the confirmed state (no destruction)", async () => {
    stubExchangeFlow({ reads: (n) => (n === 1 ? { status: 200, body: readBody([row(ITEM_A, "5", "0", "5", "SKU-A")]) } : err(401, "UNAUTHORIZED", "Token")) });
    await readyToConfirm();
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    exchangeDrafts.dropEditable();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.recovery).toEqual({ reason: "CONFIRMED" });
    expect(durableKeys()).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it("EW70 lines without a replacement are NOT silently omitted: the store refuses INCOMPLETE, so Confirmar waits until they are removed explicitly", async () => {
    stubExchangeFlow({ rows: [row(ITEM_A, "5", "0", "5", "SKU-A"), row(ITEM_B, "3", "0", "3", "SKU-B")] });
    await readyToConfirm();
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.lines).toHaveLength(2); // B is still there, with no replacement
    expect(confirmButton()).toBeDisabled();
    await expect(exchangeDrafts.send({ userId: "u1", saleId: SALE_ID, token: "tok" })).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(posts).toHaveLength(0);
    const edit = vi.spyOn(exchangeDrafts, "edit");
    fireEvent.click(screen.getByRole("button", { name: /Quitar líneas sin reemplazo/ }));
    expect(edit).toHaveBeenCalledWith("u1", SALE_ID, { type: "removeLine", saleItemId: ITEM_B });
    expect(exchangeDrafts.getDraft("u1", SALE_ID)!.lines.map((line) => line.saleItemId)).toEqual([ITEM_A]);
    expect(confirmButton()).toBeEnabled();
    fireEvent.click(confirmButton()!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.lines.map((line) => line.saleItemId)).toEqual([ITEM_A]);
    await settled();
  });

  it("EW71 reconciling ANOTHER sale from the pending list does not wipe the selection of the sale on screen", async () => {
    const SALE_B = "66666666-6666-4666-8666-666666666666";
    const ITEM_C = "55555555-5555-4555-8555-555555555555";
    const bodyB = (exchanged: string) => ({
      sale: { id: SALE_B, saleNumber: "T-B", branchId: "b1", status: "COMPLETED", pricingMode: "RETAIL", priceMode: "LIST", total: "1" },
      exchangeable: true,
      lines: [{ saleItemId: ITEM_C, variantId: "v", productName: "Otra", variantName: "X", sku: "SKU-OB", unitPrice: "100", quantity: "2", exchangedQuantity: exchanged, remainingQuantity: String(2 - Number(exchanged)) }],
    });
    let confirmedB = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/sales/exchangeable")) {
        return json(url.searchParams.get("saleNumber") === "T-B" ? bodyB(confirmedB ? "1" : "0") : readBody([row(ITEM_A, "5", "0", "5", "SKU-A")]));
      }
      if (url.pathname.endsWith("/exchanges")) {
        confirmedB = true;
        return json({ exchangeId: EX_1, replayed: false }, 201);
      }
      return json({ items: [] });
    }));
    expect((await exchangeDrafts.openDraftFromFreshRead({ userId: "u1", branchId: "b1", saleNumber: "T-B", read: bodyB("0") })).ok).toBe(true);
    exchangeDrafts.edit("u1", SALE_B, { type: "reason", value: "Talle" });
    exchangeDrafts.edit("u1", SALE_B, { type: "line", saleItemId: ITEM_C, replacementVariantId: VAR_UUID, replacementLabel: "Otra", returnQuantity: "1" });
    expect((await exchangeDrafts.send({ userId: "u1", saleId: SALE_B, token: "tok" })).kind).toBe("CONFIRMED"); // sale B is now waiting for its refresh

    render(<ExchangeWorkspace {...WHO} onSessionExpired={onExpired} />);
    typeSale("T-1");
    fireEvent.click(searchButton());
    await waitFor(() => expect(phase()).toBe("SALE_LOADED"));
    chooseLine(ITEM_A);
    setQty("3");
    fireEvent.click(within(screen.getByTestId(`draft-${SALE_B}`)).getByRole("button", { name: /Actualizar venta/ }));
    await waitFor(() => expect(exchangeDrafts.getDraft("u1", SALE_B)!.recovery).toBeNull());
    expect(qtyInput().value).toBe("3");
    expect(phase()).toBe("SALE_LOADED");
  });
});
