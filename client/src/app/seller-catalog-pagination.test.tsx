import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";

// Seller catalog pagination: GET /variants is capped at 100 per request, so
// the POS must walk the pages (server-side) instead of showing only page 1.

const TOKEN_KEY = "mona-jacinta-token";
const PAGE_SIZE = 100;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const seller = {
  id: "s1", name: "Vendedor", email: "seller@demo.local", roles: ["SELLER"],
  branchIds: ["BR1", "BR2"], permissions: [], cashMovementLocationIds: [], cashSupervisorLocationIds: [],
};

function buildVariant(prefix: string, index: number, branchId: string) {
  const n = String(index).padStart(3, "0");
  return {
    id: `${prefix}-${n}`, productId: `p-${prefix}-${n}`, sku: `${prefix}-SKU-${n}`, barcode: null,
    color: "Negro", size: "M", cashPrice: "1000000", price: "1200000", isActive: true,
    product: { id: `p-${prefix}-${n}`, name: `Prod ${prefix} ${n}`, slug: `prod-${prefix}-${n}` },
    inventory: [{ id: `i-${prefix}-${n}`, branchId, physical: "500", reserved: "0", available: "500" }],
  };
}

const CATALOG: Record<string, ReturnType<typeof buildVariant>[]> = {
  BR1: Array.from({ length: 232 }, (_, i) => buildVariant("A", i + 1, "BR1")),
  BR2: Array.from({ length: 5 }, (_, i) => buildVariant("B", i + 1, "BR2")),
};

function sale() {
  return {
    id: "sale-1", branchId: "BR1", saleNumber: null, status: "DRAFT", subtotal: "0", discountTotal: "0", total: "0",
    pricingMode: "LIST", priceMode: "CASH", items: [],
  };
}

function setup(opts: { gate?: (url: URL) => Promise<void> | undefined; failPage?: (url: URL) => boolean } = {}) {
  const variantCalls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/auth/me")) return jsonResponse({ user: seller });
    if (url.pathname.endsWith("/variants")) {
      variantCalls.push(url);
      const limit = Number(url.searchParams.get("limit"));
      const page = Number(url.searchParams.get("page") ?? "1");
      expect(limit).toBeLessThanOrEqual(PAGE_SIZE);
      const wait = opts.gate?.(url);
      if (wait) await wait;
      if (opts.failPage?.(url)) return jsonResponse({ error: { message: "boom" } }, 500);
      const branchId = url.searchParams.get("branchId") ?? "";
      const term = (url.searchParams.get("search") ?? "").toLowerCase();
      const all = (CATALOG[branchId] ?? []).filter((v) => !term || v.sku.toLowerCase().includes(term));
      return jsonResponse({
        items: all.slice((page - 1) * limit, page * limit),
        pagination: { page, limit, total: all.length },
      });
    }
    if (url.pathname.endsWith("/sales") && method === "POST") return jsonResponse(sale(), 201);
    if (url.pathname.endsWith("/sale-1/items") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        ...sale(), subtotal: "1000000", total: "1000000",
        items: [{
          id: "item-1", variantId: body.variantId, productName: "Prod A 001", variantName: "Negro / M",
          sku: "A-SKU-001", quantity: "1", unitPrice: "1000000", subtotal: "1000000",
        }],
      });
    }
    return jsonResponse({ items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { variantCalls, fetchMock };
}

async function openSale() {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  render(<OperationsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Abrir venta" }));
  await screen.findByText(/Venta en borrador/);
}

const cards = () => document.querySelectorAll(".product-card");
const loadMore = () => screen.queryByRole("button", { name: /Cargar más/ });

describe("seller catalog pagination", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts with the first page and exposes a load-more control", async () => {
    const { variantCalls } = setup();
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    expect(variantCalls[0].searchParams.get("limit")).toBe("100");
    expect(variantCalls[0].searchParams.get("page")).toBe("1");
    expect(screen.getByText(/100 de 232/)).toBeInTheDocument();
    expect(loadMore()).toBeInTheDocument();
  });

  it("walks all 232 variants without duplicates and then hides the control", async () => {
    const { variantCalls } = setup();
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    fireEvent.click(loadMore()!);
    await waitFor(() => expect(cards()).toHaveLength(200));
    fireEvent.click(loadMore()!);
    await waitFor(() => expect(cards()).toHaveLength(232));
    expect(loadMore()).not.toBeInTheDocument();
    const skus = Array.from(cards()).map((card) => card.querySelector("small")?.textContent);
    expect(new Set(skus).size).toBe(232);
    expect(variantCalls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(screen.getByText(/232 de 232/)).toBeInTheDocument();
  });

  it("does not duplicate variants if a page overlaps the previous one", async () => {
    const { fetchMock } = setup();
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    // page 2 normally returns A-101.., make it overlap by re-serving page 1 once
    const original = fetchMock.getMockImplementation()!;
    let served = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (!served && url.pathname.endsWith("/variants") && url.searchParams.get("page") === "2") {
        served = true;
        return jsonResponse({
          items: CATALOG.BR1.slice(90, 190),
          pagination: { page: 2, limit: 100, total: 232 },
        });
      }
      return original(input, init);
    }));
    fireEvent.click(loadMore()!);
    await waitFor(() => expect(cards()).toHaveLength(190));
  });

  it("search restarts at page 1 and can reach any active variant", async () => {
    const { variantCalls } = setup();
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    fireEvent.change(screen.getByPlaceholderText(/Producto, SKU/), { target: { value: "A-SKU-232" } });
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByText("A-SKU-232")).toBeInTheDocument();
    const last = variantCalls[variantCalls.length - 1];
    expect(last.searchParams.get("search")).toBe("A-SKU-232");
    expect(last.searchParams.get("page")).toBe("1");
    expect(loadMore()).not.toBeInTheDocument();
  });

  it("changing branch resets pagination and replaces the list", async () => {
    const { variantCalls } = setup();
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    fireEvent.click(loadMore()!);
    await waitFor(() => expect(cards()).toHaveLength(200));
    fireEvent.change(screen.getByLabelText("Sucursal autorizada"), { target: { value: "BR2" } });
    // changing branch drops the draft; reopen it to see the catalog again
    fireEvent.click(await screen.findByRole("button", { name: "Abrir venta" }));
    await waitFor(() => expect(cards()).toHaveLength(5));
    const last = variantCalls[variantCalls.length - 1];
    expect(last.searchParams.get("branchId")).toBe("BR2");
    expect(last.searchParams.get("page")).toBe("1");
    expect(loadMore()).not.toBeInTheDocument();
  });

  it("a late page from the previous branch never contaminates the current one", async () => {
    let releaseLate: () => void = () => {};
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    setup({ gate: (url) => (url.searchParams.get("branchId") === "BR1" && url.searchParams.get("page") === "2" ? late : undefined) });
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    fireEvent.click(loadMore()!); // BR1 page 2 stays in flight
    fireEvent.change(screen.getByLabelText("Sucursal autorizada"), { target: { value: "BR2" } });
    fireEvent.click(await screen.findByRole("button", { name: "Abrir venta" }));
    await waitFor(() => expect(cards()).toHaveLength(5));
    releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cards()).toHaveLength(5);
    expect(screen.queryByText("A-SKU-150")).not.toBeInTheDocument();
    expect(screen.getByText(/5 de 5/)).toBeInTheDocument();
  });

  it("keeps the cart intact while loading more products", async () => {
    setup();
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole("button", { name: "Agregar" }));
    const cart = document.querySelector(".cart-panel") as HTMLElement;
    await waitFor(() => expect(within(cart).getByText("Prod A 001")).toBeInTheDocument());
    const before = cart.innerHTML;
    fireEvent.click(loadMore()!);
    await waitFor(() => expect(cards()).toHaveLength(200));
    expect(document.querySelector(".cart-panel")).toBe(cart);
    expect(within(cart).getByText("Prod A 001")).toBeInTheDocument();
    expect(cart.innerHTML).toBe(before);
    expect(screen.getByText(/Venta en borrador/)).toBeInTheDocument();
  });

  it("ignores repeated clicks while a page is loading and allows retry after an error", async () => {
    let fail = true;
    const { variantCalls } = setup({ failPage: (url) => fail && url.searchParams.get("page") === "2" });
    await openSale();
    await waitFor(() => expect(cards()).toHaveLength(100));
    const button = loadMore()!;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(variantCalls.filter((u) => u.searchParams.get("page") === "2")).toHaveLength(1);
    expect(cards()).toHaveLength(100);
    fail = false;
    fireEvent.click(loadMore()!);
    await waitFor(() => expect(cards()).toHaveLength(200));
  });
});
