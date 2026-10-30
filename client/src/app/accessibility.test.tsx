import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationsPage from "./page";

// Minimal accessibility floor for the POS shell: the mode switcher exposes its state (aria-pressed), the quantity buttons have names, errors are
// announced, and keyboard focus is visible.

const TOKEN_KEY = "mona-jacinta-token";
const here = path.dirname(fileURLToPath(import.meta.url));

const json = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const user = (roles: string[]) => ({
  id: "u1", name: "Test", email: "t@demo.local", roles, branchIds: ["BR1"], permissions: [],
  cashMovementLocationIds: [], cashSupervisorLocationIds: [],
});

const variant = {
  id: "v1", productId: "p1", sku: "SKU-1", barcode: null, color: "Negro", size: "M", cashPrice: "1000000", price: "1200000", isActive: true,
  product: { id: "p1", name: "Remera", slug: "remera" }, inventory: [{ id: "i1", branchId: "BR1", physical: "50", reserved: "0", available: "50" }],
};
const emptySale = { id: "sale-1", branchId: "BR1", saleNumber: null, status: "DRAFT", subtotal: "0", discountTotal: "0", total: "0", pricingMode: "LIST", priceMode: "CASH", items: [] };
const oneItem = {
  ...emptySale, subtotal: "1000000", total: "1000000",
  items: [{ id: "item-1", variantId: "v1", productName: "Remera", variantName: "Negro / M", sku: "SKU-1", quantity: "1", unitPrice: "1000000", subtotal: "1000000" }],
};

function stub(roles: string[], extra: (url: URL, method: string) => Response | undefined = () => undefined) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const custom = extra(url, method);
    if (custom) return custom;
    if (url.pathname.endsWith("/auth/me")) return json({ user: user(roles) });
    if (url.pathname.endsWith("/variants")) return json({ items: [variant], pagination: { page: 1, limit: 100, total: 1 } });
    if (url.pathname.endsWith("/sales") && method === "POST") return json(emptySale, 201);
    if (url.pathname.endsWith("/sale-1/items") && method === "POST") return json(oneItem, 201);
    if (url.pathname.endsWith("/cash/current")) return json(null);
    if (url.pathname.endsWith("/cash/register")) return json({ id: "reg-1", branchId: "BR1", name: "Caja" });
    return json({ items: [] });
  }));
}

async function ready() {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  render(<OperationsPage />);
  await waitFor(() => expect(screen.queryByText(/Cargando sesión/i)).not.toBeInTheDocument());
}

describe("POS accessibility floor", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The mode switcher keeps button semantics and states its state with aria-pressed, instead of role="tab" + aria-selected: the tab roles
  // would make five existing test files (page, warehouse, cashier-cash-movement, cashier-cash-reversal, cashier-m1m2) look the controls
  // up as role "tab" rather than "button", churn with no operational benefit for a three-button mode switch.
  it("AX-01 each mode button states whether it is the active one with aria-pressed, and keeps its button role", async () => {
    stub(["OWNER"]);
    await ready();
    const caja = await screen.findByRole("button", { name: "Caja" });
    const venta = screen.getByRole("button", { name: "Venta" });
    expect(venta).toHaveAttribute("aria-pressed", "true");
    expect(caja).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(caja);
    expect(screen.getByRole("button", { name: "Caja" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Venta" })).toHaveAttribute("aria-pressed", "false");
    // A group of toggle buttons, not a tablist without tabs.
    expect(screen.getByRole("group", { name: "Modo de operación" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("AX-02 the cart's + and - buttons say what they change", async () => {
    stub(["SELLER"]);
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Abrir venta" }));
    fireEvent.click(await screen.findByRole("button", { name: "Agregar" }));
    expect(await screen.findByRole("button", { name: "Aumentar cantidad de Remera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disminuir cantidad de Remera" })).toBeInTheDocument();
  });

  it("AX-03 a seller-side error is announced as an alert", async () => {
    stub(["SELLER"], (url) => (url.pathname.endsWith("/variants") ? json({ error: { message: "Catálogo caído" } }, 500) : undefined));
    await ready();
    expect(await screen.findByRole("alert")).toHaveTextContent("Catálogo caído");
  });

  it("AX-04 a login error is announced as an alert", async () => {
    stub([], (url, method) => (url.pathname.endsWith("/auth/login") && method === "POST" ? json({ message: "Invalid credentials" }, 401) : undefined));
    render(<OperationsPage />);
    fireEvent.change(await screen.findByLabelText("Correo"), { target: { value: "a@b.c" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Usuario o contraseña incorrectos.");
  });

  it("AX-05 every error banner is an alert and every notice banner a status (no silent banner left in page.tsx)", () => {
    const source = readFileSync(path.join(here, "page.tsx"), "utf8");
    expect(source.match(/className="error-banner"/g)?.length ?? 0).toBeGreaterThan(0);
    expect(source.match(/className="error-banner"(?! role="alert")/g)).toBeNull();
    expect(source.match(/className="notice-banner"/g)?.length ?? 0).toBeGreaterThan(0);
    expect(source.match(/className="notice-banner"(?! role="status")/g)).toBeNull();
  });

  it("AX-06 keyboard focus is visible on buttons, links, selects and inputs", () => {
    const css = readFileSync(path.join(here, "globals.css"), "utf8");
    const rule = css.match(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    for (const selector of ["button", "a", "select", "input"]) expect(rule![1]).toContain(`${selector}:focus-visible`);
    expect(rule![2]).toMatch(/outline/);
  });
});
