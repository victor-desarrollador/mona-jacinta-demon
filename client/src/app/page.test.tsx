import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationsPage from "./page";

const TOKEN_KEY = "mona-jacinta-token";

type PublicUser = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  branchIds: string[];
  permissions: string[];
  // CLIENT-CASH-UX (2026-10-19): /auth/me branch-aware cash hints; empty here
  // — this fixture suite carries no effective cash-movement authority.
  cashMovementLocationIds: string[];
  cashSupervisorLocationIds: string[];
};

function buildUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: "u1",
    name: "Test User",
    email: "test@demo.local",
    roles: [],
    branchIds: ["branch-1"],
    permissions: [],
    cashMovementLocationIds: [],
    cashSupervisorLocationIds: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// D1 (Phase 1 Global Closeout): minimal fetch router — only the routes the
// current OperationsPage/SellerWorkspace/CashierWorkspace effects actually
// call on mount, per source inspection (page.tsx's apiRequest call sites).
// Never a giant API mock; every unlisted GET falls back to the smallest
// route-appropriate empty shape.
function createFetchRouter(user: PublicUser) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/me")) return jsonResponse({ user });
    if (url.includes("/variants")) return jsonResponse({ items: [] });
    if (url.includes("/sales/pending")) return jsonResponse({ items: [] });
    if (url.includes("/cash/current")) return jsonResponse(null);
    // CASH-1.1: the close history is an array (GET /cash/sessions).
    if (url.includes("/cash/sessions?")) return jsonResponse([]);
    if (url.includes("/cash/register")) {
      return jsonResponse({ id: "reg-1", branchId: user.branchIds[0] ?? "branch-1", name: "Caja principal" });
    }
    return jsonResponse({ items: [] });
  });
}

async function renderAuthenticated(user: PublicUser) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createFetchRouter(user));
  render(<OperationsPage />);
  await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
}

describe("OperationsPage POS role access (D1)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    // @testing-library/react's automatic cleanup relies on a global
    // `afterEach` (registered via `test.globals`/importing the `/vitest`
    // subpath) — neither is configured here, so cleanup is explicit to
    // avoid DOM/render state leaking between tests in this file.
    cleanup();
    vi.unstubAllGlobals();
  });

  it("login form starts with an empty email (no preloaded demo value)", async () => {
    vi.stubGlobal("fetch", createFetchRouter(buildUser()));
    render(<OperationsPage />);

    const email = await screen.findByLabelText("Correo");
    expect(email).toHaveValue("");
  });

  // D1 TDD Stage 2 — captured RED: a WAREHOUSE-only user has neither
  // SALE_CREATE nor SALE_CHARGE (role-permission-matrix.ts), so it must
  // never reach SellerWorkspace or CashierWorkspace. The pre-D1
  // implementation's mode fallback (`hasRole(user, "CASHIER") ? "cashier" :
  // "seller"`) has no "no POS access" state at all, so it always renders
  // SellerWorkspace by default — this test demonstrates that real bug.
  it("WAREHOUSE user sees no POS workspace and an explicit no-access message", async () => {
    const user = buildUser({ roles: ["WAREHOUSE"], branchIds: ["DEP"], permissions: ["inventory.manage"] });
    await renderAuthenticated(user);

    expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
    expect(screen.queryByText("Ventas pendientes")).not.toBeInTheDocument();
    expect(await screen.findByText("Sin acceso al punto de venta")).toBeInTheDocument();
    expect(screen.getByText("Depósito")).toBeInTheDocument();
  });

  it("SELLER user gets seller workspace by default, no cashier tab, no cashier workspace", async () => {
    const user = buildUser({ roles: ["SELLER"], branchIds: ["CEN"], permissions: ["sale.create"] });
    await renderAuthenticated(user);

    expect(await screen.findByText("Productos y variantes")).toBeInTheDocument();
    expect(screen.queryByText("Ventas pendientes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Caja" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Venta" })).toBeInTheDocument();
  });

  it("CASHIER user gets cashier workspace by default, no seller tab, no seller workspace", async () => {
    const user = buildUser({ roles: ["CASHIER"], branchIds: ["CEN"], permissions: ["sale.charge"] });
    await renderAuthenticated(user);

    expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
    expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Venta" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Caja" })).toBeInTheDocument();
  });

  it("ADMIN user has both POS controls available, seller workspace by default", async () => {
    const user = buildUser({ roles: ["ADMIN"], branchIds: [], permissions: ["report.view", "user.manage"] });
    await renderAuthenticated(user);

    expect(await screen.findByText("Productos y variantes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Caja" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Venta" })).toBeInTheDocument();
    expect(screen.getByText("Administrador")).toBeInTheDocument();
  });

  // OWNER default is deliberately SELLER, matching ADMIN — this is a frozen
  // policy decision, not an oversight.
  it("OWNER user has both POS controls available, seller workspace by default", async () => {
    const user = buildUser({ roles: ["OWNER"], branchIds: [], permissions: ["report.view", "user.manage"] });
    await renderAuthenticated(user);

    expect(await screen.findByText("Productos y variantes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Caja" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Venta" })).toBeInTheDocument();
    expect(screen.getByText("Dueño")).toBeInTheDocument();
  });

  it("a multi-role CASHIER+SELLER user (no OWNER/ADMIN) defaults to cashier mode with both controls available", async () => {
    const user = buildUser({ roles: ["CASHIER", "SELLER"], branchIds: ["CEN"], permissions: ["sale.charge", "sale.create"] });
    await renderAuthenticated(user);

    expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
    expect(screen.queryByText("Productos y variantes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Caja" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Venta" })).toBeInTheDocument();
  });

  // Branch selector labels: the real name and code (from /auth/me `branches`) replace the truncated UUID in BOTH workspaces, and only
  // branchIds ever produce options.
  it("shows the branch name and code in the Venta and Caja selectors, and only for the user's own branches", async () => {
    const user = {
      ...buildUser({ roles: ["CASHIER", "SELLER"], branchIds: ["branch-1"], permissions: ["sale.charge", "sale.create"] }),
      branches: [
        { id: "branch-1", name: "Sucursal Centro", code: "CEN" },
        { id: "branch-9", name: "Sucursal Ajena", code: "AJE" },
      ],
    };
    await renderAuthenticated(user);

    const cashier = await screen.findByRole("combobox", { name: /Sucursal autorizada/ });
    expect(Array.from((cashier as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["Sucursal Centro (CEN)"]);

    fireEvent.click(screen.getByRole("button", { name: "Venta" }));
    const seller = await screen.findByRole("combobox", { name: /Sucursal autorizada/ });
    expect(Array.from((seller as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["Sucursal Centro (CEN)"]);
    expect(screen.queryByText(/Sucursal Ajena/)).not.toBeInTheDocument();
  });
});
