import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";
import AUTH_ME from "./test-fixtures/auth-me.json";

// Cash withdrawals/expenses (pilot Block 1 cash movements) plus the
// CLIENT-CASH-UX branch-aware visibility contract (2026-10-19):
//   - the panel / Gasto / movement history render only when the ACTIVE branch
//     belongs to the server-computed user.cashMovementLocationIds;
//   - Retiro and Corregir render only when the ACTIVE branch belongs to
//     user.cashSupervisorLocationIds (OWNER or a COMPANY-reach ADMIN) — the
//     show-then-403 pattern is gone; the API stays authoritative.
// The /auth/me payloads come from the REAL public projection
// (test-fixtures/auth-me.json, pinned by
// api/tests/auth/auth-me-client-fixture.test.ts).

const TOKEN_KEY = "mona-jacinta-token";

type Call = { url: string; method: string; body?: string };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function movement(overrides: Record<string, unknown> = {}) {
  return {
    id: "movement-1",
    sessionId: "session-1",
    type: "EXPENSE",
    amount: "25000",
    salePaymentId: null,
    userId: "cashier-1",
    reason: "Flete",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    reversesMovementId: null,
    timestamp: "2030-01-02T10:00:00.000Z",
    ...overrides,
  };
}

type Actor = keyof typeof AUTH_ME;
// R-1: exactly what the real /auth/me projects for the actor
// (test-fixtures/auth-me.json, pinned by
// api/tests/auth/auth-me-client-fixture.test.ts).
const real = (actor: Actor = "CASHIER") => AUTH_ME[actor];

type RouterOptions = {
  actor?: Actor;
  permissions?: string[];
  cashMovementLocationIds?: string[];
  cashSupervisorLocationIds?: string[];
  branchIds?: string[];
  failFirstMovementPost?: boolean;
  // An OPEN session (and its own movement history) also exists at branch-2.
  branch2?: boolean;
};

const SESSION_OF: Record<string, string> = { "branch-1": "session-1", "branch-2": "session-2" };

function createRouter(options: RouterOptions = {}) {
  const calls: Call[] = [];
  let failFirstMovementPost = options.failFirstMovementPost ?? false;
  const movements: Record<string, Record<string, unknown>[]> = {
    "session-1": [movement()],
    "session-2": [movement({ id: "movement-b1", sessionId: "session-2", reason: "Flete B" })],
  };
  const me = real(options.actor ?? "CASHIER");

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });

    if (url.includes("/auth/me")) {
      return jsonResponse({
        user: {
          id: "cashier-1",
          name: "Cajero",
          email: "cashier@demo.local",
          roles: me.roles,
          branchIds: options.branchIds ?? me.cashMovementLocationIds,
          permissions: options.permissions ?? me.permissions,
          cashMovementLocationIds: options.cashMovementLocationIds ?? me.cashMovementLocationIds,
          cashSupervisorLocationIds: options.cashSupervisorLocationIds ?? me.cashSupervisorLocationIds,
        },
      });
    }
    if (url.includes("/sales/pending")) return jsonResponse({ items: [] });
    if (url.includes("/cash/sessions?")) return jsonResponse([]);
    const branchId = new URL(url, "http://x").searchParams.get("branchId") ?? "branch-1";
    if (url.includes("/cash/register")) {
      return jsonResponse({ id: "register-1", branchId, name: "Caja principal" });
    }
    if (url.includes("/cash/current")) {
      const sessionId = options.branch2 ? SESSION_OF[branchId] : "session-1";
      if (!sessionId) return jsonResponse(null);
      return jsonResponse({
        sessionId,
        registerId: `register-${branchId}`,
        branchId,
        openedById: "cashier-1",
        closedById: null,
        startingCash: "100000",
        status: "OPEN",
        openedAt: "2030-01-02T09:00:00.000Z",
        closedAt: null,
      });
    }
    const list = url.match(/\/cash\/sessions\/(session-[12])\/movements$/);
    if (list && method === "GET") return jsonResponse(movements[list[1]!] ?? []);
    const exit = url.match(/\/cash\/sessions\/(session-[12])\/(expenses|withdrawals)$/);
    if (exit && method === "POST") {
      if (failFirstMovementPost) {
        failFirstMovementPost = false;
        throw new TypeError("Failed to fetch");
      }
      const body = JSON.parse(String(init?.body));
      const created = movement({
        id: `movement-${Object.values(movements).flat().length + 1}`,
        sessionId: exit[1],
        type: exit[2] === "withdrawals" ? "WITHDRAWAL" : "EXPENSE",
        amount: body.amount,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
      });
      movements[exit[1]!] = [...(movements[exit[1]!] ?? []), created];
      return jsonResponse({ movement: created, replayed: false }, 201);
    }
    return jsonResponse({ items: [] });
  });

  return { fetch, calls };
}

async function renderCashier(options: RouterOptions = {}) {
  const router = createRouter(options);
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", router.fetch);
  render(<OperationsPage />);
  if (options.actor === "OWNER" || options.actor === "ADMIN_COMPANY" || options.actor === "ADMIN_LOCATION") {
    // Frozen POS access policy: OWNER / ADMIN land in the seller workspace.
    fireEvent.click(await screen.findByRole("button", { name: "Caja" }));
  }
  expect(await screen.findByRole("heading", { name: "Movimientos de caja" })).toBeInTheDocument();
  return router;
}

// Loads the page at a branch whose arrays do NOT cover it, so the movements
// panel (and everything inside it) must never render.
async function renderPanelHidden(options: RouterOptions = {}) {
  const router = createRouter(options);
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", router.fetch);
  render(<OperationsPage />);
  if (options.actor === "OWNER" || options.actor === "ADMIN_COMPANY" || options.actor === "ADMIN_LOCATION") {
    fireEvent.click(await screen.findByRole("button", { name: "Caja" }));
  }
  expect(await screen.findByRole("combobox", { name: /Sucursal autorizada/ })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Movimientos de caja" })).not.toBeInTheDocument();
  return router;
}

function movementPosts(calls: Call[]) {
  return calls.filter((call) => call.method === "POST" && /\/(expenses|withdrawals)$/.test(call.url));
}

const history = () => screen.getByRole("heading", { name: "Movimientos actuales de la sesión" }).parentElement!;

describe("cash withdrawals and expenses", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the current session movements and registers an exact-cent expense after confirmation", async () => {
    const { calls } = await renderCashier();
    expect(await screen.findByText("Flete")).toBeInTheDocument();
    expect(screen.getByText("$ 250")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Importe ARS" }), { target: { value: "1.209,40" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Motivo" }), { target: { value: "  Insumos  " } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar gasto" }));

    expect(movementPosts(calls)).toHaveLength(0);
    expect(screen.getByText("Confirmar gasto")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar gasto" }));

    await waitFor(() => expect(movementPosts(calls)).toHaveLength(1));
    const body = JSON.parse(movementPosts(calls)[0]!.body!);
    expect(body).toMatchObject({ amount: "120940", reason: "Insumos" });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await screen.findByText("Gasto registrado.")).toBeInTheDocument();
    expect(await screen.findByText("Insumos")).toBeInTheDocument();
  });

  // CLIENT-CASH-UX: supersedes the earlier "a CASHIER confirms a withdrawal"
  // flow — the supervisor rule did not change (cash.service.ts), but the
  // Withdrawal act is offered ONLY to the branch's supervisors now, so a
  // real withdrawal flow belongs to a supervisor actor (see the visibility
  // tests below and cashier-cash-reversal.test.tsx).
  it("a supervisor (ADMIN COMPANY) confirms a withdrawal and it posts to /withdrawals", async () => {
    const { calls } = await renderCashier({ actor: "ADMIN_COMPANY" });
    fireEvent.click(screen.getByRole("radio", { name: "Retiro" }));
    expect(screen.getByText(/requiere confirmación de un supervisor/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Importe ARS" }), { target: { value: "300" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Motivo" }), { target: { value: "Depósito bancario" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar retiro" }));
    expect(screen.getByText(/requiere supervisor/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar retiro" }));
    await waitFor(() => expect(movementPosts(calls)[0]?.url).toMatch(/\/withdrawals$/));
  });

  it("reuses the same idempotency key when the same confirmed submit is retried after transport failure", async () => {
    const { calls } = await renderCashier({ failFirstMovementPost: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Importe ARS" }), { target: { value: "50" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Motivo" }), { target: { value: "Limpieza" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar gasto" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar gasto" }));

    expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar gasto" }));
    expect(await screen.findByText("Gasto registrado.")).toBeInTheDocument();

    const posts = movementPosts(calls);
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]!.body!).idempotencyKey).toBe(JSON.parse(posts[1]!.body!).idempotencyKey);
  });
});

describe("branch-aware cash movement visibility (CLIENT-CASH-UX)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a CASHIER at its own branch sees the panel, Gasto and history, but never Retiro nor Corregir", async () => {
    await renderCashier();
    expect(screen.getByRole("radio", { name: "Gasto" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Retiro" })).not.toBeInTheDocument();
    expect(within(history()).queryByRole("button", { name: /^Corregir/ })).not.toBeInTheDocument();
    expect(await within(history()).findByText("Flete")).toBeInTheDocument();
  });

  it("an ADMIN with COMPANY reach sees Retiro and Corregir at an authorized branch", async () => {
    await renderCashier({ actor: "ADMIN_COMPANY" });
    expect(screen.getByRole("radio", { name: "Retiro" })).toBeInTheDocument();
    expect(await within(history()).findByRole("button", { name: /^Corregir/ })).toBeInTheDocument();
  });

  it("an ADMIN LOCATION with the grant sees Gasto and history but neither Retiro nor Corregir", async () => {
    await renderCashier({ actor: "ADMIN_LOCATION" });
    expect(screen.queryByRole("radio", { name: "Retiro" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Gasto" })).toBeInTheDocument();
    expect(within(history()).queryByRole("button", { name: /^Corregir/ })).not.toBeInTheDocument();
    expect(await within(history()).findByText("Flete")).toBeInTheDocument();
  });

  it("the panel renders only at an authorized branch, and every branch switch recalculates it from the real arrays", async () => {
    // Start pinned to the unauthorized branch: the panel (and nothing of
    // branch-1's history) must never appear, and session-2's history is never
    // even requested.
    const router = await renderPanelHidden({
      branchIds: ["branch-2", "branch-1"],
      cashMovementLocationIds: ["branch-1"],
      cashSupervisorLocationIds: [],
      branch2: true,
    });
    expect(screen.queryByText(/Flete/)).not.toBeInTheDocument();
    expect(router.calls.some((call) => /session-2\/movements/.test(call.url))).toBe(false);

    // A→...→A round trip in the branch-aware world: authorized → unauthorized
    // → authorized, each switch recalculated from the new active branch.
    const select = () => screen.getByRole("combobox", { name: /Sucursal autorizada/ });
    fireEvent.change(select(), { target: { value: "branch-1" } });
    expect(await screen.findByRole("heading", { name: "Movimientos de caja" })).toBeInTheDocument();
    expect(await screen.findByText("Flete")).toBeInTheDocument();
    expect(screen.queryByText("Flete B")).not.toBeInTheDocument();

    fireEvent.change(select(), { target: { value: "branch-2" } });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Movimientos de caja" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Flete/)).not.toBeInTheDocument();
  });
});
