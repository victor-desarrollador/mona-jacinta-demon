import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";
import AUTH_ME from "./test-fixtures/auth-me.json";

// PILOT cash movement reversal (migration 11): the cashier panel parses the
// reversal types, keeps every original visible ("Corregido"), offers
// "Corregir" only for an unreversed WITHDRAWAL / EXPENSE of the open session,
// and posts only { reason, idempotencyKey } — never an amount.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-18, extended 2026-10-19):
//   RV-01 a history carrying WITHDRAWAL_REVERSAL / EXPENSE_REVERSAL parses; the original stays visible marked "Corregido"
//   RV-02 "Corregir" only for unreversed WITHDRAWAL / EXPENSE rows (never OPENING, SALE_INCOME, a reversal or a reversed original)
//   RV-03 the confirmation shows the original read-only + the supervisor notice; a blank reason posts nothing
//   RV-04 confirm posts exactly { reason, idempotencyKey } to /movements/:id/reversal, then refreshes
//   RV-05 a transport failure retries with the SAME key; a new intent gets a NEW key
//   RV-06 an inconsistent reversal row (no link) makes the history fail closed
//   RV-07 (R-1) with the REAL /auth/me of an OWNER / COMPANY ADMIN the panel and Corregir render
//   RV-08 (R-1) without an effective cash-movement hint (a CASHIER-shaped /auth/me whose cashMovementLocationIds exclude the branch, or a SELLER) no panel renders
//   RV-09 (R-2) a branch change closes the open correction: no A movement, reason or intent survives; B is usable
//   RV-10 (R-2/R-3) while A's correction is pending the branch selector is locked (no switch, no cross-branch POST); unlocked after the answer
//   RV-11 (R-3) while an exit POST is pending the branch selector is locked, so no re-keyed duplicate exit can be produced by A→B→A
//   RV-12 (CLIENT-CASH-UX, R-2) the WITHDRAWAL kind itself is branch-bound supervision state: switching to a non-supervisor branch hides Retiro and resets the kind to Gasto
//   RV-13 (CLIENT-CASH-UX) an ADMIN LOCATION (real /auth/me) manages Gasto/Historial at its branch but never sees Retiro or Corregir

const TOKEN_KEY = "mona-jacinta-token";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

const OPENING = movement({ id: "opening-1", type: "OPENING", amount: "100000", reason: null, idempotencyKey: null });
const SALE = movement({ id: "sale-1", type: "SALE_INCOME", amount: "5000", reason: null, idempotencyKey: null, salePaymentId: "payment-1" });

type Actor = keyof typeof AUTH_ME;
type RouterOptions = {
  failFirstReversal?: boolean;
  actor?: Actor;
  permissions?: string[];
  // CLIENT-CASH-UX (2026-10-19): the branch-aware /auth/me hints. They default
  // to the actor's REAL fixture values and can be reshaped per test.
  cashMovementLocationIds?: string[];
  cashSupervisorLocationIds?: string[];
  // A second authorized branch with its own open session and movements.
  branch2Movements?: Record<string, unknown>[];
  // Keep every reversal / exit POST pending until release() is called.
  holdReversals?: boolean;
  holdExits?: boolean;
};

const SESSION_OF: Record<string, string> = { "branch-1": "session-1", "branch-2": "session-2" };

function createRouter(initial: Record<string, unknown>[], options: RouterOptions = {}) {
  const calls: Call[] = [];
  let failFirstReversal = options.failFirstReversal ?? false;
  const movementsBySession: Record<string, Record<string, unknown>[]> = {
    "session-1": [...initial],
    "session-2": [...(options.branch2Movements ?? [])],
  };
  const held: Array<() => void> = [];
  // CLIENT-CASH-UX: everything that touches Retiro/Corregir needs the
  // supervisor audience, so the default actor is the COMPANY ADMIN fixture
  // (the CASHIER fixture's own tests live in cashier-cash-movement.test.tsx).
  const real = AUTH_ME[options.actor ?? "ADMIN_COMPANY"];

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });

    if (url.includes("/auth/me")) {
      // R-1: exactly what the real /auth/me projects for this actor
      // (test-fixtures/auth-me.json, pinned against toPublicUserContext by
      // api/tests/auth/auth-me-client-fixture.test.ts), including the two
      // branch-aware cash hints.
      return jsonResponse({
        user: {
          id: "user-1", name: "Usuario", email: "user@demo.local", roles: real.roles,
          branchIds: options.branch2Movements ? ["branch-1", "branch-2"] : ["branch-1"],
          permissions: options.permissions ?? real.permissions,
          cashMovementLocationIds: options.cashMovementLocationIds ?? real.cashMovementLocationIds,
          cashSupervisorLocationIds: options.cashSupervisorLocationIds ?? real.cashSupervisorLocationIds,
        },
      });
    }
    if (url.includes("/sales/pending")) return jsonResponse({ items: [] });
    if (url.includes("/cash/sessions?")) return jsonResponse([]);
    const branchId = new URL(url, "http://x").searchParams.get("branchId") ?? "branch-1";
    if (url.includes("/cash/register")) return jsonResponse({ id: `register-${branchId}`, branchId, name: `Caja ${branchId}` });
    if (url.includes("/cash/current")) {
      return jsonResponse({
        sessionId: SESSION_OF[branchId], registerId: `register-${branchId}`, branchId, openedById: "cashier-1", closedById: null,
        startingCash: "100000", status: "OPEN", openedAt: "2030-01-02T09:00:00.000Z", closedAt: null,
      });
    }
    const list = url.match(/\/cash\/sessions\/(session-[12])\/movements$/);
    if (list && method === "GET") return jsonResponse(movementsBySession[list[1]!]);
    const exit = url.match(/\/cash\/sessions\/(session-[12])\/(expenses|withdrawals)$/);
    if (exit && method === "POST") {
      if (options.holdExits) await new Promise<void>((release) => held.push(release));
      const body = JSON.parse(String(init?.body));
      const created = movement({
        id: `exit-${movementsBySession[exit[1]!]!.length + 1}`, sessionId: exit[1],
        type: exit[2] === "withdrawals" ? "WITHDRAWAL" : "EXPENSE", amount: body.amount, reason: body.reason, idempotencyKey: body.idempotencyKey,
      });
      movementsBySession[exit[1]!] = [...movementsBySession[exit[1]!]!, created];
      return jsonResponse({ movement: created, replayed: false }, 201);
    }
    const reversal = url.match(/\/cash\/sessions\/(session-[12])\/movements\/([^/]+)\/reversal$/);
    if (reversal && method === "POST") {
      if (options.holdReversals) await new Promise<void>((release) => held.push(release));
      if (failFirstReversal) {
        failFirstReversal = false;
        throw new TypeError("Failed to fetch");
      }
      const body = JSON.parse(String(init?.body));
      const movements = movementsBySession[reversal[1]!]!;
      const original = movements.find((m) => m.id === reversal[2])!;
      const created = movement({
        id: `reversal-${movements.length + 1}`,
        sessionId: reversal[1],
        type: `${String(original.type)}_REVERSAL`,
        amount: original.amount,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
        reversesMovementId: original.id,
        userId: "owner-1",
      });
      movementsBySession[reversal[1]!] = [...movements, created];
      return jsonResponse({ movement: created, original, replayed: false }, 201);
    }
    return jsonResponse({ items: [] });
  });

  return { fetch, calls, releaseReversals: () => held.splice(0).forEach((release) => release()), actor: options.actor ?? "ADMIN_COMPANY" };
}

async function renderPanel(initial: Record<string, unknown>[], options: RouterOptions = {}) {
  const router = createRouter(initial, options);
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", router.fetch);
  render(<OperationsPage />);
  // OWNER / ADMIN land in the seller workspace (frozen POS access policy).
  if (router.actor === "OWNER" || router.actor === "ADMIN_COMPANY" || router.actor === "ADMIN_LOCATION") {
    fireEvent.click(await screen.findByRole("button", { name: "Caja" }));
  }
  expect(await screen.findByRole("heading", { name: "Movimientos de caja" })).toBeInTheDocument();
  return router;
}

const reversalPosts = (calls: Call[]) => calls.filter((call) => call.method === "POST" && /\/reversal$/.test(call.url));
const history = () => screen.getByRole("heading", { name: "Movimientos actuales de la sesión" }).parentElement!;

describe("cash movement reversal (Corregir)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("RV-01 parses reversal rows and keeps the original visible, marked Corregido", async () => {
    await renderPanel([
      OPENING,
      movement({ id: "w-1", type: "WITHDRAWAL", amount: "30000", reason: "Retiro mal cargado" }),
      movement({ id: "r-1", type: "WITHDRAWAL_REVERSAL", amount: "30000", reason: "Duplicado", reversesMovementId: "w-1" }),
    ]);
    const list = history();
    expect(await within(list).findByText("Reversión de retiro")).toBeInTheDocument();
    expect(within(list).getByText("Retiro mal cargado")).toBeInTheDocument();
    expect(within(list).getByText("Corregido")).toBeInTheDocument();
    expect(within(list).queryByText(/No se pudieron cargar/)).not.toBeInTheDocument();
  });

  it("RV-02 offers Corregir only for unreversed WITHDRAWAL / EXPENSE rows", async () => {
    await renderPanel([
      OPENING,
      SALE,
      movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto vigente" }),
      movement({ id: "w-1", type: "WITHDRAWAL", amount: "30000", reason: "Retiro corregido" }),
      movement({ id: "r-1", type: "WITHDRAWAL_REVERSAL", amount: "30000", reason: "Duplicado", reversesMovementId: "w-1" }),
    ]);
    await within(history()).findByText("Gasto vigente");
    const buttons = within(history()).getAllByRole("button", { name: /^Corregir/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Corregir Gasto vigente");
  });

  it("RV-03 shows the original read-only with the supervisor notice; a blank reason posts nothing", async () => {
    const { calls } = await renderPanel([OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto vigente" })]);
    fireEvent.click(await within(history()).findByRole("button", { name: "Corregir Gasto vigente" }));
    const dialog = screen.getByRole("group", { name: "Corregir movimiento" });
    expect(within(dialog).getByText("Gasto")).toBeInTheDocument();
    expect(within(dialog).getByText("$ 40")).toBeInTheDocument();
    expect(within(dialog).getByText("Gasto vigente")).toBeInTheDocument();
    expect(within(dialog).getByText(/requiere supervisor \(OWNER o ADMIN con alcance COMPANY\)/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: /Importe/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar corrección" }));
    expect(await screen.findByText("Ingresá el motivo de la corrección.")).toBeInTheDocument();
    expect(reversalPosts(calls)).toHaveLength(0);
  });

  it("RV-04 posts exactly { reason, idempotencyKey } and refreshes the history", async () => {
    const { calls } = await renderPanel([OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto vigente" })]);
    fireEvent.click(await within(history()).findByRole("button", { name: "Corregir Gasto vigente" }));
    const dialog = screen.getByRole("group", { name: "Corregir movimiento" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Motivo de la corrección" }), { target: { value: "  Cargado dos veces  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar corrección" }));

    await waitFor(() => expect(reversalPosts(calls)).toHaveLength(1));
    expect(reversalPosts(calls)[0]!.url).toMatch(/\/cash\/sessions\/session-1\/movements\/e-1\/reversal$/);
    const body = JSON.parse(reversalPosts(calls)[0]!.body!);
    expect(Object.keys(body).sort()).toEqual(["idempotencyKey", "reason"]);
    expect(body.reason).toBe("Cargado dos veces");
    expect(body.idempotencyKey).toMatch(UUID_V4);
    expect(await screen.findByText("Corrección registrada.")).toBeInTheDocument();
    expect(await within(history()).findByText("Reversión de gasto")).toBeInTheDocument();
    expect(within(history()).getByText("Corregido")).toBeInTheDocument();
    expect(within(history()).getByText("Gasto vigente")).toBeInTheDocument();
    expect(within(history()).queryByRole("button", { name: /^Corregir/ })).not.toBeInTheDocument();
  });

  it("RV-05 a transport failure retries with the same key; a new intent gets a new key", async () => {
    const { calls } = await renderPanel(
      [OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto vigente" })],
      { failFirstReversal: true },
    );
    fireEvent.click(await within(history()).findByRole("button", { name: "Corregir Gasto vigente" }));
    let dialog = screen.getByRole("group", { name: "Corregir movimiento" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Motivo de la corrección" }), { target: { value: "Duplicado" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar corrección" }));
    expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();

    // Cancel and start over: a NEW intent, so a NEW key is minted.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    fireEvent.click(within(history()).getByRole("button", { name: "Corregir Gasto vigente" }));
    dialog = screen.getByRole("group", { name: "Corregir movimiento" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Motivo de la corrección" }), { target: { value: "Duplicado" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar corrección" }));
    expect(await screen.findByText("Corrección registrada.")).toBeInTheDocument();
    const [failed, fresh] = reversalPosts(calls).map((call) => JSON.parse(call.body!).idempotencyKey);
    expect(fresh).not.toBe(failed);
  });

  it("RV-05b the retry of the SAME confirmed intent reuses its key", async () => {
    const { calls } = await renderPanel(
      [OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto vigente" })],
      { failFirstReversal: true },
    );
    fireEvent.click(await within(history()).findByRole("button", { name: "Corregir Gasto vigente" }));
    const dialog = screen.getByRole("group", { name: "Corregir movimiento" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Motivo de la corrección" }), { target: { value: "Duplicado" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar corrección" }));
    expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();
    // While a confirmed intent awaits its retry, its reason cannot drift.
    expect(within(dialog).getByRole("textbox", { name: "Motivo de la corrección" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reintentar corrección" }));
    expect(await screen.findByText("Corrección registrada.")).toBeInTheDocument();
    const posts = reversalPosts(calls);
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]!.body!).idempotencyKey).toBe(JSON.parse(posts[1]!.body!).idempotencyKey);
  });

  it("RV-06 an inconsistent reversal row (no link) makes the history fail closed", async () => {
    await renderPanel([OPENING, movement({ id: "r-1", type: "EXPENSE_REVERSAL", amount: "4000", reason: "x", reversesMovementId: null })]);
    expect(await within(history()).findByText("No se pudieron cargar los movimientos de caja.")).toBeInTheDocument();
  });

  it("RV-07 (R-1) the REAL /auth/me of an OWNER and of a COMPANY ADMIN reaches the panel and Corregir", async () => {
    for (const actor of ["OWNER", "ADMIN_COMPANY"] as const) {
      await renderPanel([OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto vigente" })], { actor });
      expect(await within(history()).findByRole("button", { name: "Corregir Gasto vigente" })).toBeEnabled();
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("RV-08 (R-1) without an effective cash-movement hint no movement panel renders and no movement is requested", async () => {
    // CLIENT-CASH-UX: the panel gate is the branch-aware hint, not the global
    // permission string — a CASHIER whose /auth/me says the ACTIVE branch is
    // not in cashMovementLocationIds sees nothing (even though the
    // compatibility `permissions` array may still list the code).
    const router = createRouter([OPENING], { actor: "CASHIER", cashMovementLocationIds: [] });
    window.localStorage.setItem(TOKEN_KEY, "test-token");
    vi.stubGlobal("fetch", router.fetch);
    render(<OperationsPage />);
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Movimientos de caja" })).not.toBeInTheDocument();
    expect(router.calls.some((call) => /\/movements/.test(call.url))).toBe(false);
    cleanup();
    vi.unstubAllGlobals();

    // A SELLER has no cashier workspace at all.
    const seller = createRouter([OPENING], { actor: "SELLER" });
    vi.stubGlobal("fetch", seller.fetch);
    render(<OperationsPage />);
    await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Movimientos de caja" })).not.toBeInTheDocument();
    expect(seller.calls.some((call) => /\/movements/.test(call.url))).toBe(false);
  });

  const branchSelect = () => screen.getByRole("combobox", { name: /Sucursal autorizada/ });
  const B_EXPENSE = movement({ id: "e-b", sessionId: "session-2", type: "EXPENSE", amount: "700", reason: "Gasto B" });

  // The two-branch tests use a COMPANY-admin-like /auth/me whose hints cover
  // BOTH authorized branches (the one-location fixture universe expands to a
  // single id; this test's world has two).
  const BOTH_HITS = { cashMovementLocationIds: ["branch-1", "branch-2"], cashSupervisorLocationIds: ["branch-1", "branch-2"] };

  it("RV-09 (R-2) a branch change closes the open correction: nothing of branch A survives and branch B is usable", async () => {
    const { calls } = await renderPanel(
      [OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto A" })],
      { branch2Movements: [movement({ id: "o-b", sessionId: "session-2", type: "OPENING", amount: "100000", reason: null, idempotencyKey: null }), B_EXPENSE], ...BOTH_HITS },
    );
    fireEvent.click(await within(history()).findByRole("button", { name: "Corregir Gasto A" }));
    const dialog = screen.getByRole("group", { name: "Corregir movimiento" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Motivo de la corrección" }), { target: { value: "Motivo de A" } });

    fireEvent.change(branchSelect(), { target: { value: "branch-2" } });
    expect(await screen.findByText("Gasto B")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Corregir movimiento" })).not.toBeInTheDocument();
    expect(screen.queryByText("Gasto A")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Motivo de A")).not.toBeInTheDocument();

    // B is usable: its own Corregir is enabled, opens EMPTY and posts to B's session only.
    const correctB = within(history()).getByRole("button", { name: "Corregir Gasto B" });
    expect(correctB).toBeEnabled();
    fireEvent.click(correctB);
    const dialogB = screen.getByRole("group", { name: "Corregir movimiento" });
    expect(within(dialogB).getByRole("textbox", { name: "Motivo de la corrección" })).toHaveValue("");
    fireEvent.change(within(dialogB).getByRole("textbox", { name: "Motivo de la corrección" }), { target: { value: "Motivo de B" } });
    fireEvent.click(within(dialogB).getByRole("button", { name: "Confirmar corrección" }));
    expect(await screen.findByText("Corrección registrada.")).toBeInTheDocument();
    const posts = reversalPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/\/cash\/sessions\/session-2\/movements\/e-b\/reversal$/);
    expect(JSON.parse(posts[0]!.body!).reason).toBe("Motivo de B");
  });

  it("RV-10 (R-2/R-3) while A's correction is pending the branch selector is locked; it unlocks after the answer and nothing crosses branches", async () => {
    const router = await renderPanel(
      [OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto A" })],
      { holdReversals: true, branch2Movements: [movement({ id: "o-b", sessionId: "session-2", type: "OPENING", amount: "100000", reason: null, idempotencyKey: null }), B_EXPENSE], ...BOTH_HITS },
    );
    fireEvent.click(await within(history()).findByRole("button", { name: "Corregir Gasto A" }));
    const dialog = screen.getByRole("group", { name: "Corregir movimiento" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Motivo de la corrección" }), { target: { value: "Motivo de A" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar corrección" }));
    await waitFor(() => expect(reversalPosts(router.calls)).toHaveLength(1));
    expect(branchSelect()).toBeDisabled();

    router.releaseReversals();
    expect(await screen.findByText("Corrección registrada.")).toBeInTheDocument();
    expect(branchSelect()).toBeEnabled();
    const posts = reversalPosts(router.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/session-1\/movements\/e-1\/reversal$/);
  });

  it("RV-11 (R-3) while an exit POST is pending the branch selector is locked: no A→B→A round trip can re-key a duplicate exit", async () => {
    const router = await renderPanel(
      [OPENING],
      { holdExits: true, branch2Movements: [movement({ id: "o-b", sessionId: "session-2", type: "OPENING", amount: "100000", reason: null, idempotencyKey: null })], ...BOTH_HITS },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Importe ARS" }), { target: { value: "50" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Motivo" }), { target: { value: "Limpieza" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar gasto" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar gasto" }));
    const exitPosts = () => router.calls.filter((call) => call.method === "POST" && /\/(expenses|withdrawals)$/.test(call.url));
    await waitFor(() => expect(exitPosts()).toHaveLength(1));
    expect(branchSelect()).toBeDisabled();

    router.releaseReversals();
    expect(await screen.findByText("Gasto registrado.")).toBeInTheDocument();
    expect(branchSelect()).toBeEnabled();
    expect(exitPosts()).toHaveLength(1);
  });

  // CLIENT-CASH-UX (2026-10-19): the WITHDRAWAL kind is branch-bound
  // supervision state. At branch-1 the supervisor selects Retiro; switching to
  // branch-2 (same /auth/me, but its supervision hint covers only branch-1)
  // hides the Retiro radio AND resets the kind — the form can never carry a
  // Retiro review/confirm that this branch's supervisor rule will only 403.
  it("RV-12 (R-2/CLIENT-CASH-UX) a branch switch to a non-supervised branch hides Retiro and resets the kind to Gasto", async () => {
    await renderPanel(
      [OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto A" })],
      {
        branch2Movements: [movement({ id: "o-b", sessionId: "session-2", type: "OPENING", amount: "100000", reason: null, idempotencyKey: null })],
        cashMovementLocationIds: ["branch-1", "branch-2"],
        cashSupervisorLocationIds: ["branch-1"],
      },
    );
    expect(screen.getByRole("radio", { name: "Retiro" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Retiro" }));

    fireEvent.change(branchSelect(), { target: { value: "branch-2" } });
    expect(await screen.findByRole("radio", { name: "Gasto" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Retiro" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revisar gasto" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revisar retiro/ })).not.toBeInTheDocument();
  });

  // CLIENT-CASH-UX: the real ADMIN LOCATION audience — the ACTIVE branch
  // carries the grant (Gasto/Historial visible) but never supervision, so
  // Retiro and Corregir are absent exactly as the server would 403 them.
  it("RV-13 (CLIENT-CASH-UX) the real ADMIN LOCATION /auth/me manages Gasto/Historial but never offers Retiro or Corregir", async () => {
    await renderPanel(
      [OPENING, movement({ id: "e-1", type: "EXPENSE", amount: "4000", reason: "Gasto vigente" })],
      { actor: "ADMIN_LOCATION" },
    );
    expect(await within(history()).findByText("Gasto vigente")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Retiro" })).not.toBeInTheDocument();
    expect(within(history()).queryByRole("button", { name: /^Corregir/ })).not.toBeInTheDocument();
  });
});
