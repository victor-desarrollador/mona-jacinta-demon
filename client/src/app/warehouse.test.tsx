import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";
import AUTH_ME from "./test-fixtures/auth-me.json";

// WAREHOUSE-MVP: the Depósito module (manual stock adjustment) inside client/.
// Visibility is the server-computed user.inventoryManageLocationIds hint — never
// the role name — and the API stays authoritative. The /auth/me payloads come
// from the REAL public projection (test-fixtures/auth-me.json, pinned by
// api/tests/auth/auth-me-client-fixture.test.ts).
//
// PRE-REGISTERED EXPECTATIONS (2026-10-20): W01..W30.

const TOKEN_KEY = "mona-jacinta-token";
const PENDING_KEY = "mona-jacinta-warehouse-pending-adjustment";

type Call = { url: string; method: string; body?: Record<string, unknown> };
type Row = {
  variantId: string; productId: string; productName: string; sku: string; barcode: string;
  color: string | null; size: string | null; physical: string; reserved: string; available: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(n: number, overrides: Partial<Row> = {}): Row {
  return {
    variantId: `variant-${n}`, productId: `product-${n}`, productName: `Remera ${n}`, sku: `SKU-${n}`, barcode: `779${n}`,
    color: "Negro", size: "M", physical: "10", reserved: "4", available: "6", ...overrides,
  };
}

type Actor = keyof typeof AUTH_ME;
type Deferred = { promise: Promise<Response>; resolve: (response: Response) => void };
function deferred(): Deferred {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

type RouterOptions = {
  me?: Record<string, unknown>;
  catalog?: Record<string, Row[]>;
  // consumed in order by POST /inventory/adjustments; "network" rejects the fetch
  adjust?: Array<Response | "network" | Deferred>;
  // consumed in order by GET /inventory/stock; falls back to the catalog filter
  stock?: Array<Deferred | undefined>;
};

function createRouter(options: RouterOptions = {}) {
  const calls: Call[] = [];
  // What localStorage held for the pending attempt at the instant each POST left.
  const pendingAtPost: Array<string | null> = [];
  // The fixture holds only the projected authority; id / name / branchIds complete a real user.
  const me = { id: "u1", name: "Test User", email: "test@demo.local", branchIds: ["branch-1"], ...(options.me ?? AUTH_ME.WAREHOUSE) };
  const catalog = options.catalog ?? { "branch-1": [row(1), row(2)] };
  const adjustQueue = [...(options.adjust ?? [])];
  const stockQueue = [...(options.stock ?? [])];

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    if (url.includes("/auth/me")) return jsonResponse({ user: me });
    if (url.includes("/inventory/stock")) {
      const query = new URL(url, "http://x").searchParams;
      const queued = stockQueue.shift();
      const respond = (): Response => {
        const rows = (catalog[query.get("branchId") ?? ""] ?? []).filter((r) => {
          const term = (query.get("search") ?? "").toLowerCase();
          return !term || [r.productName, r.sku, r.barcode, r.color ?? "", r.size ?? ""].some((v) => v.toLowerCase().includes(term));
        });
        const page = Number(query.get("page") ?? "1");
        const limit = Number(query.get("limit") ?? "50");
        return jsonResponse({ items: rows.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: rows.length } });
      };
      return queued ? queued.promise.then((r) => r ?? respond()) : respond();
    }
    if (url.includes("/inventory/adjustments")) {
      pendingAtPost.push(window.localStorage.getItem(PENDING_KEY));
      const next = adjustQueue.shift();
      if (next === "network") throw new TypeError("Failed to fetch");
      if (next && "promise" in next) return next.promise;
      return next ?? jsonResponse({ replayed: false }, 201);
    }
    // The sale / cash workspaces of OWNER / ADMIN / CASHIER / SELLER mount with these shapes.
    if (url.includes("/cash/current")) return jsonResponse(null);
    if (url.includes("/cash/sessions?")) return jsonResponse([]);
    if (url.includes("/cash/register")) return jsonResponse({ id: "reg-1", branchId: "branch-1", name: "Caja principal" });
    return jsonResponse({ items: [] });
  });
  return { fetch, calls, pendingAtPost, stockCalls: () => calls.filter((c) => c.url.includes("/inventory/stock")), adjustCalls: () => calls.filter((c) => c.url.includes("/inventory/adjustments")) };
}

async function renderAs(options: RouterOptions = {}) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  const router = createRouter(options);
  vi.stubGlobal("fetch", router.fetch);
  render(<OperationsPage />);
  await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
  return router;
}

// A page reload: the DOM and every in-memory ref are gone, localStorage survives.
async function reloadAs(options: RouterOptions = {}) {
  cleanup();
  vi.unstubAllGlobals();
  return renderAs(options);
}
const readPending = () => {
  const raw = window.localStorage.getItem(PENDING_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};
const PENDING_MESSAGE = "Hay un ajuste de stock pendiente de confirmar.";

const adjustedResponse = (variantId: string, physical: string, reserved = "4", replayed = false) =>
  jsonResponse({
    replayed,
    movement: { id: "m1", type: "ADJUSTMENT" },
    inventory: { id: "inv1", variantId, branchId: "branch-1", physical, reserved, available: String(BigInt(physical) - BigInt(reserved)) },
  }, replayed ? 200 : 201);

const apiError = (status: number, code: string, message: string) => jsonResponse({ error: { code, message } }, status);

async function openModal(sku = "SKU-1") {
  const button = await screen.findByRole("button", { name: `Ajustar ${sku}` });
  fireEvent.click(button);
  return screen.findByRole("dialog");
}
function fill(dialog: HTMLElement, values: { delta?: string; reason?: string; note?: string }) {
  if (values.delta !== undefined) fireEvent.change(within(dialog).getByLabelText(/Cantidad a ajustar/), { target: { value: values.delta } });
  if (values.reason !== undefined) fireEvent.change(within(dialog).getByLabelText("Motivo"), { target: { value: values.reason } });
  if (values.note !== undefined) fireEvent.change(within(dialog).getByLabelText("Nota"), { target: { value: values.note } });
}
const confirmButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Confirmar ajuste" });

describe("Depósito (WAREHOUSE-MVP)", () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  describe("access", () => {
    it("W01 a pure WAREHOUSE lands on Depósito and sees neither Venta nor Caja", async () => {
      await renderAs();
      expect(await screen.findByRole("heading", { name: "Depósito" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Venta" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Caja" })).not.toBeInTheDocument();
      expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
    });

    it("W02 a WAREHOUSE role without any inventory location keeps the explicit no-access message", async () => {
      await renderAs({ me: { ...AUTH_ME.WAREHOUSE, inventoryManageLocationIds: [] } });
      expect(await screen.findByText("Sin acceso al punto de venta")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Depósito" })).not.toBeInTheDocument();
    });

    it.each(["OWNER", "ADMIN_COMPANY", "ADMIN_LOCATION"] as Actor[])("W03 %s keeps Venta / Caja, defaults to Venta and can open Depósito", async (actor) => {
      await renderAs({ me: { ...AUTH_ME[actor], branchIds: ["branch-1"] }, catalog: { "branch-1": [row(1)] } });
      expect(await screen.findByText("Productos y variantes")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Venta" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Caja" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Depósito" }));
      expect(await screen.findByRole("heading", { name: "Depósito" })).toBeInTheDocument();
      expect(await screen.findByText("Remera 1")).toBeInTheDocument();
    });

    it.each(["CASHIER", "SELLER"] as Actor[])("W04 %s has no Depósito tab (empty hint)", async (actor) => {
      await renderAs({ me: { ...AUTH_ME[actor], branchIds: ["branch-1"] } });
      await screen.findByRole("button", { name: actor === "CASHIER" ? "Caja" : "Venta" });
      expect(screen.queryByRole("button", { name: "Depósito" })).not.toBeInTheDocument();
    });

    it("W05 a user whose old API omits the hint does not crash and gets no Depósito", async () => {
      const legacy: Record<string, unknown> = { ...AUTH_ME.SELLER };
      delete legacy.inventoryManageLocationIds;
      await renderAs({ me: { ...legacy, branchIds: ["branch-1"] } });
      await screen.findByRole("button", { name: "Venta" });
      expect(screen.queryByRole("button", { name: "Depósito" })).not.toBeInTheDocument();
    });

    it("W06 the branch selector offers exactly user.inventoryManageLocationIds and loads the first one", async () => {
      const router = await renderAs({
        me: { ...AUTH_ME.WAREHOUSE, branchIds: ["branch-1", "branch-2", "branch-3"], inventoryManageLocationIds: ["branch-2", "branch-3"] },
        catalog: { "branch-2": [row(2)], "branch-3": [row(3)] },
      });
      const select = await screen.findByLabelText(/Sucursal/);
      expect(within(select).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["branch-2", "branch-3"]);
      expect(await screen.findByText("Remera 2")).toBeInTheDocument();
      expect(router.stockCalls()[0]!.url).toContain("branchId=branch-2");
    });
  });

  describe("stock list", () => {
    it("W07 renders product, color, size, SKU and the three quantities per row", async () => {
      await renderAs({ catalog: { "branch-1": [row(1, { physical: "12", reserved: "5", available: "7", color: "Rojo", size: "L" })] } });
      const line = (await screen.findByText("Remera 1")).closest("tr")!;
      for (const text of ["Rojo", "L", "SKU-1", "12", "5", "7"]) expect(within(line).getByText(text)).toBeInTheDocument();
    });

    it("W08 searches by submitting the term and resets to page 1", async () => {
      const router = await renderAs({ catalog: { "branch-1": [row(1), row(2, { productName: "Buzo Polar", sku: "BUZ-2" })] } });
      await screen.findByText("Remera 1");
      fireEvent.change(screen.getByLabelText(/Buscar producto/), { target: { value: "buzo" } });
      fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
      await waitFor(() => expect(screen.queryByText("Remera 1")).not.toBeInTheDocument());
      expect(screen.getByText("Buzo Polar")).toBeInTheDocument();
      const last = router.stockCalls().at(-1)!.url;
      expect(last).toContain("search=buzo");
      expect(last).toContain("page=1");
    });

    it("W09 paginates with the real total", async () => {
      const many = Array.from({ length: 120 }, (_, index) => row(index + 1));
      const router = await renderAs({ catalog: { "branch-1": many } });
      expect(await screen.findByText(/Página 1 de 3/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
      expect(await screen.findByText(/Página 2 de 3/)).toBeInTheDocument();
      expect(router.stockCalls().at(-1)!.url).toContain("page=2");
      expect(await screen.findByText("Remera 51")).toBeInTheDocument();
    });

    it("W10 shows an explicit empty state", async () => {
      await renderAs({ catalog: { "branch-1": [] } });
      expect(await screen.findByText(/No hay productos para mostrar/)).toBeInTheDocument();
    });

    it("W11 a slow answer for an older search never overwrites the newer one (stale responses)", async () => {
      const slow = deferred();
      const router = await renderAs({
        catalog: { "branch-1": [row(1), row(2, { productName: "Buzo Polar" })] },
        stock: [undefined, slow, undefined],
      });
      await screen.findByText("Remera 1");
      const input = screen.getByLabelText(/Buscar producto/);
      fireEvent.change(input, { target: { value: "remera" } });
      fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
      await waitFor(() => expect(router.stockCalls()).toHaveLength(2));
      fireEvent.change(input, { target: { value: "buzo" } });
      fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
      expect(await screen.findByText("Buzo Polar")).toBeInTheDocument();
      slow.resolve(jsonResponse({ items: [row(1)], pagination: { page: 1, limit: 50, total: 1 } }));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByText("Buzo Polar")).toBeInTheDocument();
      expect(screen.queryByText("Remera 1")).not.toBeInTheDocument();
    });

    it("W12 a slow answer for the previous branch never overwrites the new branch (stale responses)", async () => {
      const slow = deferred();
      await renderAs({
        me: { ...AUTH_ME.WAREHOUSE, branchIds: ["branch-1", "branch-2"], inventoryManageLocationIds: ["branch-1", "branch-2"] },
        catalog: { "branch-1": [row(1)], "branch-2": [row(2)] },
        stock: [slow, undefined],
      });
      const select = await screen.findByLabelText(/Sucursal/);
      fireEvent.change(select, { target: { value: "branch-2" } });
      expect(await screen.findByText("Remera 2")).toBeInTheDocument();
      slow.resolve(jsonResponse({ items: [row(1)], pagination: { page: 1, limit: 50, total: 1 } }));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText("Remera 1")).not.toBeInTheDocument();
      expect(screen.getByText("Remera 2")).toBeInTheDocument();
    });
  });

  describe("adjustment modal", () => {
    it("W13 shows product, variant, current / reserved / available stock and the resulting physical", async () => {
      await renderAs({ catalog: { "branch-1": [row(1, { physical: "10", reserved: "4", available: "6" })] } });
      const dialog = await openModal();
      for (const text of ["Remera 1", "SKU-1", "Stock físico actual", "Reservado", "Disponible"]) expect(within(dialog).getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
      expect(within(dialog).getByTestId("resulting-physical")).toHaveTextContent("10");
      fill(dialog, { delta: "5" });
      expect(within(dialog).getByTestId("resulting-physical")).toHaveTextContent("15");
      fill(dialog, { delta: "-3" });
      expect(within(dialog).getByTestId("resulting-physical")).toHaveTextContent("7");
    });

    it("W14 the reason constrains the sign (DAMAGED / LOST negative, SURPLUS positive, LOAD_ERROR and OTHER both)", async () => {
      await renderAs();
      const dialog = await openModal();
      fill(dialog, { delta: "3", reason: "DAMAGED" });
      expect(confirmButton(dialog)).toBeDisabled();
      expect(within(dialog).getByText(/solo admite ajustes negativos/)).toBeInTheDocument();
      fill(dialog, { reason: "LOST" });
      expect(confirmButton(dialog)).toBeDisabled();
      fill(dialog, { delta: "-3", reason: "SURPLUS" });
      expect(confirmButton(dialog)).toBeDisabled();
      expect(within(dialog).getByText(/solo admite ajustes positivos/)).toBeInTheDocument();
      fill(dialog, { delta: "3", reason: "SURPLUS" });
      expect(confirmButton(dialog)).toBeEnabled();
      fill(dialog, { delta: "3", reason: "LOAD_ERROR" });
      expect(confirmButton(dialog)).toBeEnabled();
      fill(dialog, { delta: "-3", reason: "LOAD_ERROR" });
      expect(confirmButton(dialog)).toBeEnabled();
    });

    it("W15 OTHER needs a note of at least 10 characters (trimmed)", async () => {
      await renderAs();
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "OTHER", note: "  corta  " });
      expect(confirmButton(dialog)).toBeDisabled();
      expect(within(dialog).getByText(/al menos 10 caracteres/)).toBeInTheDocument();
      fill(dialog, { note: "0123456789" });
      expect(confirmButton(dialog)).toBeEnabled();
    });

    it("W16 other reasons do not require a note", async () => {
      await renderAs();
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      expect(confirmButton(dialog)).toBeEnabled();
    });

    it.each([["0"], ["101"], ["-101"], ["1.5"], ["abc"], [""], ["1e2"]])("W17 refuses delta %j", async (delta) => {
      await renderAs({ catalog: { "branch-1": [row(1, { physical: "500", reserved: "0", available: "500" })] } });
      const dialog = await openModal();
      fill(dialog, { delta, reason: "LOAD_ERROR" });
      expect(confirmButton(dialog)).toBeDisabled();
    });

    it("W18 accepts the +100 / -100 boundaries", async () => {
      await renderAs({ catalog: { "branch-1": [row(1, { physical: "500", reserved: "0", available: "500" })] } });
      const dialog = await openModal();
      fill(dialog, { delta: "100", reason: "LOAD_ERROR" });
      expect(confirmButton(dialog)).toBeEnabled();
      fill(dialog, { delta: "-100" });
      expect(confirmButton(dialog)).toBeEnabled();
      fill(dialog, { delta: "101" });
      expect(within(dialog).getByText(/100 unidades/)).toBeInTheDocument();
    });

    it("W19 refuses a result below zero or below the reserved quantity", async () => {
      await renderAs({ catalog: { "branch-1": [row(1, { physical: "5", reserved: "3", available: "2" })] } });
      const dialog = await openModal();
      fill(dialog, { delta: "-6", reason: "LOST" });
      expect(confirmButton(dialog)).toBeDisabled();
      expect(within(dialog).getByText(/negativo/)).toBeInTheDocument();
      fill(dialog, { delta: "-3" });
      expect(confirmButton(dialog)).toBeDisabled();
      expect(within(dialog).getByText(/por debajo de lo reservado/)).toBeInTheDocument();
      fill(dialog, { delta: "-2" });
      expect(confirmButton(dialog)).toBeEnabled();
    });
  });

  describe("submit", () => {
    it("W20 sends delta as a signed string with variant, branch, reason, trimmed note and a UUID key, then updates the row", async () => {
      const router = await renderAs({ adjust: [adjustedResponse("variant-1", "7")] });
      const dialog = await openModal();
      fill(dialog, { delta: "+3", reason: "DAMAGED" });
      fill(dialog, { delta: "-3", note: "  se cayó de la góndola  " });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      const call = router.adjustCalls()[0]!;
      expect(call.method).toBe("POST");
      expect(call.body).toMatchObject({ variantId: "variant-1", branchId: "branch-1", delta: "-3", reason: "DAMAGED", note: "se cayó de la góndola" });
      expect(String(call.body!.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      const line = screen.getByText("Remera 1").closest("tr")!;
      expect(within(line).getByText("7")).toBeInTheDocument();
      expect(screen.getByText(/Ajuste registrado/)).toBeInTheDocument();
    });

    it("W21 omits the note when it is empty", async () => {
      const router = await renderAs({ adjust: [adjustedResponse("variant-1", "12")] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS", note: "   " });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      expect(router.adjustCalls()[0]!.body).not.toHaveProperty("note");
    });

    it("W22 a double click sends one request (guard + disabled button)", async () => {
      const pending = deferred();
      const router = await renderAs({ adjust: [pending] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      fireEvent.click(confirmButton(dialog));
      expect(confirmButton(dialog)).toBeDisabled();
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      pending.resolve(adjustedResponse("variant-1", "12"));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(router.adjustCalls()).toHaveLength(1);
    });

    it("W23 a network failure offers 'Reintentar mismo ajuste' that reuses the SAME idempotency key", async () => {
      const router = await renderAs({ adjust: ["network", adjustedResponse("variant-1", "12", "4", true)] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      const retry = await within(dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
      expect(within(dialog).getByText(/No se pudo confirmar/)).toBeInTheDocument();
      fireEvent.click(retry);
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(2));
      const [first, second] = router.adjustCalls();
      expect(second!.body!.idempotencyKey).toBe(first!.body!.idempotencyKey);
      expect(second!.body).toEqual(first!.body);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it.each([
      ["delta", { delta: "3" }],
      ["reason", { reason: "LOAD_ERROR" }],
      ["note", { note: "otra nota distinta" }],
    ])("W24 after an uncertain failure the form is frozen: changing the %s cannot send a different adjustment", async (_name, change) => {
      const router = await renderAs({ adjust: ["network", adjustedResponse("variant-1", "13")] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS", note: "nota original larga" });
      fireEvent.click(confirmButton(dialog));
      await within(dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
      fill(dialog, change);
      expect(confirmButton(dialog)).toBeDisabled();
      expect(within(dialog).getByLabelText(/Cantidad a ajustar/)).toBeDisabled();
      fireEvent.click(confirmButton(dialog));
      await new Promise((r) => setTimeout(r, 20));
      expect(router.adjustCalls()).toHaveLength(1);
    });

    it("W25 after a success the next adjustment uses a new key", async () => {
      const router = await renderAs({ adjust: [adjustedResponse("variant-1", "12"), adjustedResponse("variant-1", "14")] });
      let dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(2));
      expect(router.adjustCalls()[1]!.body!.idempotencyKey).not.toBe(router.adjustCalls()[0]!.body!.idempotencyKey);
    });

    it("W26 401 ends the session with 'Tu sesión expiró.' on the login screen", async () => {
      await renderAs({ adjust: [apiError(401, "UNAUTHORIZED", "Token inválido")] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      expect(await screen.findByText(/Tu sesión expiró/)).toBeInTheDocument();
      expect(screen.getByLabelText("Correo")).toBeInTheDocument();
      expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    it("W27 403 shows a permission message and keeps the modal open", async () => {
      await renderAs({ adjust: [apiError(403, "FORBIDDEN", "No cuenta con permisos para esta operación.")] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      expect(await within(dialog).findByText(/No tenés permiso|No cuenta con permisos/)).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Reintentar mismo ajuste" })).not.toBeInTheDocument();
    });

    it.each([
      ["NEGATIVE_STOCK", "El ajuste dejaría el stock físico en negativo."],
      ["STOCK_BELOW_RESERVED", "El ajuste dejaría el stock físico por debajo de lo reservado."],
      ["VARIANT_INACTIVE", "La variante está inactiva y no admite ajustes de stock."],
      ["CONCURRENCY_ERROR", "La operación no pudo completarse por concurrencia."],
      ["IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "La clave de idempotencia ya fue utilizada con otro ajuste."],
    ])("W28 409 %s shows the backend message and refreshes the list", async (code, message) => {
      const router = await renderAs({ adjust: [apiError(409, code, message)] });
      const dialog = await openModal();
      fill(dialog, { delta: "-1", reason: "LOST" });
      const before = router.stockCalls().length;
      fireEvent.click(confirmButton(dialog));
      expect(await within(dialog).findByText(message)).toBeInTheDocument();
      await waitFor(() => expect(router.stockCalls().length).toBe(before + 1));
    });

    it("W29 a replayed answer (200) closes the modal like a success", async () => {
      await renderAs({ adjust: [adjustedResponse("variant-1", "12", "4", true)] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("W30 cancelling the modal after an uncertain failure does NOT forget the attempt: Depósito shows it and blocks new adjustments", async () => {
      const router = await renderAs({ adjust: ["network"] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      await within(dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText(PENDING_MESSAGE)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ajustar SKU-1" })).toBeDisabled();
      expect(readPending()).toMatchObject({ idempotencyKey: router.adjustCalls()[0]!.body!.idempotencyKey });
    });
  });

  describe("durable idempotency (audit H2)", () => {
    const submitOne = async (options: RouterOptions, form = { delta: "2", reason: "SURPLUS" }) => {
      const router = await renderAs(options);
      const dialog = await openModal();
      fill(dialog, form);
      fireEvent.click(confirmButton(dialog));
      return { router, dialog };
    };

    it("P01 persists the attempt BEFORE the POST with key, variant, branch, delta, reason and normalized note", async () => {
      const { router } = await submitOne({ adjust: [adjustedResponse("variant-1", "12")] }, { delta: "-2", reason: "LOST" });
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      const stored = JSON.parse(router.pendingAtPost[0]!) as Record<string, unknown>;
      expect(stored).toMatchObject({
        idempotencyKey: router.adjustCalls()[0]!.body!.idempotencyKey,
        variantId: "variant-1",
        branchId: "branch-1",
        delta: "-2",
        reason: "LOST",
      });
    });

    it("P01b the stored note is the trimmed note actually sent", async () => {
      const router = await renderAs({ adjust: [adjustedResponse("variant-1", "12")] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS", note: "   hallazgo en conteo   " });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      expect(JSON.parse(router.pendingAtPost[0]!)).toMatchObject({ normalizedNote: "hallazgo en conteo" });
      expect(router.adjustCalls()[0]!.body).toMatchObject({ note: "hallazgo en conteo" });
    });

    it("P02 a confirmed 201 clears the pending attempt", async () => {
      await submitOne({ adjust: [adjustedResponse("variant-1", "12")] });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
      expect(screen.queryByText(PENDING_MESSAGE)).not.toBeInTheDocument();
    });

    it("P03 a replayed 200 clears the pending attempt", async () => {
      await submitOne({ adjust: [adjustedResponse("variant-1", "12", "4", true)] });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    });

    it("P04 a network error keeps the pending attempt", async () => {
      const { dialog } = await submitOne({ adjust: ["network"] });
      await within(dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
      expect(readPending()).not.toBeNull();
    });

    it.each([500, 502, 503, 504])("P05 an uncertain %i keeps the pending attempt", async (status) => {
      const { dialog } = await submitOne({ adjust: [apiError(status, "INTERNAL_ERROR", "boom")] });
      await within(dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
      expect(readPending()).not.toBeNull();
    });

    it("P05b a request timeout (aborted fetch) keeps the pending attempt", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const hang = deferred();
        const router = await renderAs({ adjust: [hang] });
        // the fake fetch ignores the abort signal; emulate the browser rejecting on abort
        const original = router.fetch.getMockImplementation()!;
        router.fetch.mockImplementation(async (input, init) => {
          if (!String(input).includes("/inventory/adjustments")) return original(input, init);
          return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        });
        const dialog = await openModal();
        fill(dialog, { delta: "2", reason: "SURPLUS" });
        fireEvent.click(confirmButton(dialog));
        await vi.advanceTimersByTimeAsync(21_000);
        await within(dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
        expect(readPending()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      [400, "VALIDATION_ERROR"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "NEGATIVE_STOCK"],
      [409, "STOCK_BELOW_RESERVED"],
      [409, "VARIANT_INACTIVE"],
      [409, "CONCURRENCY_ERROR"],
      [409, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"],
    ])("P05c a definitive rejection %i %s proves nothing applied and clears the pending attempt", async (status, code) => {
      const { dialog } = await submitOne({ adjust: [apiError(status, code, "rechazado")] }, { delta: "-1", reason: "LOST" });
      await within(dialog).findByText("rechazado");
      expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Reintentar mismo ajuste" })).not.toBeInTheDocument();
    });

    it("P05d a 401 (rejected before processing) clears the pending attempt and ends the session", async () => {
      await submitOne({ adjust: [apiError(401, "UNAUTHORIZED", "Token inválido")] });
      expect(await screen.findByText(/Tu sesión expiró/)).toBeInTheDocument();
      expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    });

    it("P06 after a reload the pending attempt is detected, announced, and blocks new adjustments", async () => {
      await submitOne({ adjust: ["network"] });
      await reloadAs();
      expect(await screen.findByText(PENDING_MESSAGE)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reintentar ajuste pendiente" })).toBeEnabled();
      expect(await screen.findByRole("button", { name: "Ajustar SKU-1" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Ajustar SKU-2" })).toBeDisabled();
    });

    it("P07 retrying after a reload sends EXACTLY the same payload and idempotency key, then clears and refreshes", async () => {
      const first = await submitOne({ adjust: ["network"] }, { delta: "-2", reason: "LOST" });
      await within(first.dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
      const original = first.router.adjustCalls()[0]!.body!;
      const stored = window.localStorage.getItem(PENDING_KEY);

      const router = await reloadAs({ adjust: [adjustedResponse("variant-1", "8", "4", true)] });
      await screen.findByText(PENDING_MESSAGE);
      const stockBefore = router.stockCalls().length;
      fireEvent.click(screen.getByRole("button", { name: "Reintentar ajuste pendiente" }));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      expect(router.adjustCalls()[0]!.body).toEqual(original);
      expect(router.pendingAtPost[0]).toBe(stored);
      await waitFor(() => expect(window.localStorage.getItem(PENDING_KEY)).toBeNull());
      await waitFor(() => expect(router.stockCalls().length).toBeGreaterThan(stockBefore));
      expect(screen.queryByText(PENDING_MESSAGE)).not.toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Ajustar SKU-1" })).toBeEnabled();
    });

    it("P07b a retry that fails again keeps the same pending attempt and key", async () => {
      const first = await submitOne({ adjust: ["network"] });
      await within(first.dialog).findByRole("button", { name: "Reintentar mismo ajuste" });
      const key = first.router.adjustCalls()[0]!.body!.idempotencyKey;
      const router = await reloadAs({ adjust: [apiError(503, "UNAVAILABLE", "x"), adjustedResponse("variant-1", "12")] });
      await screen.findByText(PENDING_MESSAGE);
      fireEvent.click(screen.getByRole("button", { name: "Reintentar ajuste pendiente" }));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      await waitFor(() => expect(screen.getByRole("button", { name: "Reintentar ajuste pendiente" })).toBeEnabled());
      expect(readPending()).toMatchObject({ idempotencyKey: key });
      fireEvent.click(screen.getByRole("button", { name: "Reintentar ajuste pendiente" }));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(2));
      expect(router.adjustCalls()[1]!.body!.idempotencyKey).toBe(key);
    });

    it("P07c a definitive rejection of the retried attempt clears it and unblocks Depósito", async () => {
      await submitOne({ adjust: ["network"] });
      const router = await reloadAs({ adjust: [apiError(409, "NEGATIVE_STOCK", "El ajuste dejaría el stock físico en negativo.")] });
      await screen.findByText(PENDING_MESSAGE);
      fireEvent.click(screen.getByRole("button", { name: "Reintentar ajuste pendiente" }));
      expect(await screen.findByText("El ajuste dejaría el stock físico en negativo.")).toBeInTheDocument();
      expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
      expect(router.adjustCalls()).toHaveLength(1);
      expect(await screen.findByRole("button", { name: "Ajustar SKU-1" })).toBeEnabled();
    });

    it("P08 while an attempt is pending no other adjustment can be opened or sent, and there is no discard control", async () => {
      const { router } = await submitOne({ adjust: ["network"] });
      await screen.findByRole("button", { name: "Reintentar mismo ajuste" });
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      fireEvent.click(screen.getByRole("button", { name: "Ajustar SKU-2" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /descartar|olvidar|cancelar ajuste pendiente|limpiar/i })).not.toBeInTheDocument();
      expect(router.adjustCalls()).toHaveLength(1);
    });

    it("P08b a pending attempt of ANOTHER user is not retried by this one, is not overwritten and blocks adjustments", async () => {
      const foreign = JSON.stringify({
        idempotencyKey: "foreign-key", variantId: "variant-1", branchId: "branch-1", delta: "2", reason: "SURPLUS", normalizedNote: null, userId: "someone-else", productName: "Remera 1", sku: "SKU-1",
      });
      window.localStorage.setItem(PENDING_KEY, foreign);
      const router = await renderAs();
      expect(await screen.findByText(/otro usuario/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reintentar ajuste pendiente" })).not.toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Ajustar SKU-1" })).toBeDisabled();
      expect(window.localStorage.getItem(PENDING_KEY)).toBe(foreign);
      expect(router.adjustCalls()).toHaveLength(0);
    });

    it("P08c a corrupted pending record cannot be replayed and does not lock the screen", async () => {
      window.localStorage.setItem(PENDING_KEY, "{not json");
      await renderAs();
      expect(await screen.findByRole("button", { name: "Ajustar SKU-1" })).toBeEnabled();
      expect(screen.queryByText(PENDING_MESSAGE)).not.toBeInTheDocument();
    });

    it("P08d if the attempt cannot be persisted nothing is sent", async () => {
      const original = Storage.prototype.setItem;
      const router = await renderAs();
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === PENDING_KEY) throw new DOMException("quota", "QuotaExceededError");
        return original.call(this, key, value);
      });
      try {
        fireEvent.click(confirmButton(dialog));
        expect(await within(dialog).findByText(/No se pudo guardar/)).toBeInTheDocument();
        expect(router.adjustCalls()).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("P09 without a sent attempt a different form (delta / reason / variant) mints a different key", async () => {
      const router = await renderAs({
        adjust: [apiError(409, "NEGATIVE_STOCK", "rechazado"), apiError(409, "NEGATIVE_STOCK", "rechazado"), apiError(409, "NEGATIVE_STOCK", "rechazado")],
      });
      let dialog = await openModal();
      fill(dialog, { delta: "-1", reason: "LOST" });
      fireEvent.click(confirmButton(dialog));
      await within(dialog).findByText("rechazado");
      fill(dialog, { delta: "-2" });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(2));
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
      dialog = await openModal("SKU-2");
      fill(dialog, { delta: "-2", reason: "LOST" });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(3));
      const keys = router.adjustCalls().map((call) => call.body!.idempotencyKey);
      expect(new Set(keys).size).toBe(3);
    });

    it("P09b a different branch with no pending attempt mints a different key", async () => {
      const router = await renderAs({
        me: { ...AUTH_ME.WAREHOUSE, branchIds: ["branch-1", "branch-2"], inventoryManageLocationIds: ["branch-1", "branch-2"] },
        catalog: { "branch-1": [row(1)], "branch-2": [row(1)] },
        adjust: [apiError(409, "NEGATIVE_STOCK", "rechazado"), apiError(409, "NEGATIVE_STOCK", "rechazado")],
      });
      let dialog = await openModal();
      fill(dialog, { delta: "-1", reason: "LOST" });
      fireEvent.click(confirmButton(dialog));
      await within(dialog).findByText("rechazado");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
      fireEvent.change(await screen.findByLabelText(/Sucursal/), { target: { value: "branch-2" } });
      await screen.findByText("Remera 1");
      dialog = await openModal();
      fill(dialog, { delta: "-1", reason: "LOST" });
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(2));
      const [first, second] = router.adjustCalls();
      expect(second!.body!.branchId).toBe("branch-2");
      expect(second!.body!.idempotencyKey).not.toBe(first!.body!.idempotencyKey);
    });

    it("P10 a double click sends one POST and persists one attempt", async () => {
      const pending = deferred();
      const router = await renderAs({ adjust: [pending] });
      const dialog = await openModal();
      fill(dialog, { delta: "2", reason: "SURPLUS" });
      fireEvent.click(confirmButton(dialog));
      fireEvent.click(confirmButton(dialog));
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      pending.resolve(adjustedResponse("variant-1", "12"));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(router.adjustCalls()).toHaveLength(1);
      expect(router.pendingAtPost).toHaveLength(1);
    });

    it("P10b a double click on the pending retry sends one POST", async () => {
      await submitOne({ adjust: ["network"] });
      const hold = deferred();
      const router = await reloadAs({ adjust: [hold] });
      await screen.findByText(PENDING_MESSAGE);
      const retry = screen.getByRole("button", { name: "Reintentar ajuste pendiente" });
      fireEvent.click(retry);
      fireEvent.click(retry);
      await waitFor(() => expect(router.adjustCalls()).toHaveLength(1));
      hold.resolve(adjustedResponse("variant-1", "12"));
      await waitFor(() => expect(window.localStorage.getItem(PENDING_KEY)).toBeNull());
      expect(router.adjustCalls()).toHaveLength(1);
    });
  });
});
