"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";

type User = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  branchIds: string[];
  permissions: string[];
};

type Inventory = {
  id: string;
  branchId: string;
  physical: string;
  reserved: string;
  available: string;
};

type Variant = {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  price: string;
  isActive: boolean;
  product: { id: string; name: string; slug: string };
  inventory: Inventory[];
};

type SaleItem = {
  id: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  subtotal: string;
};

type Sale = {
  id: string;
  branchId: string;
  saleNumber: string | null;
  status: "DRAFT" | "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED";
  subtotal: string;
  discountTotal: string;
  total: string;
  branch?: { id: string; name: string; code: string };
  seller?: { id: string; name: string; email: string };
  items: SaleItem[];
};

type ApiError = { message?: string };

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";
const TOKEN_KEY = "mona-jacinta-token";
const money = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const ZERO = BigInt(0);
const ONE = BigInt(1);
const ONE_HUNDRED = BigInt(100);

function formatMoney(cents: string) {
  const pesos = BigInt(cents) / ONE_HUNDRED;
  return money.format(Number(pesos));
}

function toQuantity(value: string) {
  return Number(BigInt(value));
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function variantLabel(variant: Pick<Variant, "color" | "size">) {
  return [variant.color, variant.size].filter(Boolean).join(" / ") || "Unica";
}

async function apiRequest<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error((body as ApiError).message ?? "No se pudo completar la operacion.");
  }

  return body as T;
}

export default function SellerSalesPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("seller01@demo.local");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [branchId, setBranchId] = useState("");
  const [variants, setVariants] = useState<Variant[]>([]);
  const [sale, setSale] = useState<Sale | null>(null);
  const [sentSale, setSentSale] = useState<Sale | null>(null);
  const [search, setSearch] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const savedToken = window.localStorage.getItem(TOKEN_KEY);
    if (!savedToken) {
      setAuthLoading(false);
      return;
    }

    setToken(savedToken);
    apiRequest<{ user: User }>("/auth/me", savedToken)
      .then(({ user: currentUser }) => {
        setUser(currentUser);
        setBranchId(currentUser.branchIds[0] ?? "");
      })
      .catch(() => {
        window.localStorage.removeItem(TOKEN_KEY);
        setToken(null);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!token || !branchId) return;

    const controller = new AbortController();
    const query = new URLSearchParams({ branchId, limit: "100" });
    if (search.trim()) query.set("search", search.trim());

    setCatalogLoading(true);
    setError("");

    apiRequest<{ items: Variant[] }>(`/variants?${query.toString()}`, token, {
      signal: controller.signal,
    })
      .then(({ items }) => setVariants(items))
      .catch((cause: Error) => {
        if (cause.name !== "AbortError") setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });

    return () => controller.abort();
  }, [token, branchId, search]);

  const saleItemCount = useMemo(
    () => sale?.items.reduce((sum, item) => sum + toQuantity(item.quantity), 0) ?? 0,
    [sale],
  );

  const selectedBranchLabel = sale?.branch
    ? `${sale.branch.name} (${sale.branch.code})`
    : branchId
      ? `Sucursal ${shortId(branchId)}`
      : "Sin sucursal";

  const demoReady = useMemo(() => {
    const remera = sale?.items.find(
      (item) => item.productName === "Remera Basica" || item.productName === "Remera Básica",
    );
    const jean = sale?.items.find((item) => item.productName === "Jean Slim");
    return (
      toQuantity(remera?.quantity ?? "0") === 2 &&
      remera?.variantName === "Negro / M" &&
      remera.unitPrice === "4500000" &&
      toQuantity(jean?.quantity ?? "0") === 1 &&
      jean?.variantName === "Azul / 42" &&
      jean.unitPrice === "7500000" &&
      sale?.total === "16500000"
    );
  }, [sale]);

  function stockForBranch(variant: Variant) {
    return BigInt(
      variant.inventory.find((item) => item.branchId === branchId)?.available ?? "0",
    );
  }

  function lineQuantityInSale(variantId: string) {
    const item = sale?.items.find((candidate) => candidate.variantId === variantId);
    return BigInt(item?.quantity ?? "0");
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionLoading(true);
    setError("");

    try {
      const result = await apiRequest<{ accessToken: string; user: User }>("/auth/login", null, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      window.localStorage.setItem(TOKEN_KEY, result.accessToken);
      setToken(result.accessToken);
      setUser(result.user);
      setBranchId(result.user.branchIds[0] ?? "");
      setSale(null);
      setSentSale(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo iniciar sesion.");
    } finally {
      setActionLoading(false);
    }
  }

  function logout() {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setBranchId("");
    setVariants([]);
    setSale(null);
    setSentSale(null);
    setError("");
  }

  async function startSale() {
    if (!token || !branchId) return;

    setActionLoading(true);
    setError("");

    try {
      const draft = await apiRequest<Sale>("/sales", token, {
        method: "POST",
        body: JSON.stringify({ branchId }),
      });
      setSale(draft);
      setSentSale(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir la venta.");
    } finally {
      setActionLoading(false);
    }
  }

  async function addVariant(variant: Variant) {
    if (!token || !sale || stockForBranch(variant) <= lineQuantityInSale(variant.id)) return;

    setActionLoading(true);
    setError("");

    try {
      const nextSale = await apiRequest<Sale>(`/sales/${sale.id}/items`, token, {
        method: "POST",
        body: JSON.stringify({ variantId: variant.id, quantity: "1" }),
      });
      setSale(nextSale);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo agregar el articulo.");
    } finally {
      setActionLoading(false);
    }
  }

  async function updateItem(item: SaleItem, nextQuantity: bigint) {
    if (!token || !sale) return;

    setActionLoading(true);
    setError("");

    try {
      const nextSale =
        nextQuantity > ZERO
          ? await apiRequest<Sale>(`/sales/${sale.id}/items/${item.id}`, token, {
              method: "PATCH",
              body: JSON.stringify({ quantity: nextQuantity.toString() }),
            })
          : await apiRequest<Sale>(`/sales/${sale.id}/items/${item.id}`, token, {
              method: "DELETE",
            });
      setSale(nextSale);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar el articulo.");
    } finally {
      setActionLoading(false);
    }
  }

  async function sendToCashier() {
    if (!token || !sale || sale.items.length === 0) return;

    setActionLoading(true);
    setError("");

    try {
      const sent = await apiRequest<Sale>(`/sales/${sale.id}/send-to-cashier`, token, {
        method: "POST",
      });
      setSentSale(sent);
      setSale(null);
      setVariants((items) =>
        items.map((variant) => ({
          ...variant,
          inventory: variant.inventory.map((row) =>
            row.branchId === sent.branchId
              ? {
                  ...row,
                  reserved: (
                    BigInt(row.reserved) +
                    BigInt(
                      sent.items.find((item) => item.variantId === variant.id)?.quantity ?? "0",
                    )
                  ).toString(),
                  available: (
                    BigInt(row.available) -
                    BigInt(
                      sent.items.find((item) => item.variantId === variant.id)?.quantity ?? "0",
                    )
                  ).toString(),
                }
              : row,
          ),
        })),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo enviar la venta a caja.");
    } finally {
      setActionLoading(false);
    }
  }

  function changeBranch(nextBranchId: string) {
    setBranchId(nextBranchId);
    setSale(null);
    setSentSale(null);
    setError("");
  }

  if (authLoading) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="brand-mark">MJ</div>
          <p className="eyebrow">Mona Jacinta Operaciones</p>
          <h1>Cargando sesion</h1>
          <p className="muted">Estamos preparando el punto de venta.</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="brand-mark">MJ</div>
          <p className="eyebrow">Mona Jacinta Operaciones</p>
          <h1>Punto de venta</h1>
          <p className="muted">Ingresa con tu usuario de vendedor para comenzar.</p>

          <form className="login-form" onSubmit={login}>
            <label>
              Correo
              <input
                autoComplete="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Contrasena
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error ? <p className="error-banner">{error}</p> : null}
            <button className="primary-button" disabled={actionLoading}>
              {actionLoading ? "Ingresando..." : "Ingresar"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="pos-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-mark small">MJ</span>
          <span>
            Mona Jacinta
            <small>OPERACIONES</small>
          </span>
        </div>
        <div className="user-menu">
          <span>
            {user.name}
            <small>{user.roles.join(" / ")}</small>
          </span>
          <button className="text-button" onClick={logout}>
            Salir
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="catalog-column">
          <div className="page-heading">
            <div>
              <p className="eyebrow">Venta vendedor</p>
              <h1>Productos y variantes</h1>
            </div>
            <span className="status-pill">API conectada</span>
          </div>

          <div className="toolbar">
            <label className="branch-select">
              Sucursal autorizada
              <select
                value={branchId}
                onChange={(event) => changeBranch(event.target.value)}
                disabled={user.branchIds.length === 0 || actionLoading}
              >
                {user.branchIds.map((id) => (
                  <option key={id} value={id}>
                    {sale?.branch?.id === id ? `${sale.branch.name} (${sale.branch.code})` : shortId(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="search-box">
              Buscar
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Producto, SKU, color, talle o codigo"
              />
            </label>
          </div>

          <div className="branch-context">
            <strong>{selectedBranchLabel}</strong>
            <span>{variants.length} variantes visibles para esta sucursal</span>
          </div>

          {error ? <p className="error-banner">{error}</p> : null}

          {sentSale ? (
            <section className="success-panel">
              <div className="success-icon">OK</div>
              <div>
                <p className="eyebrow">Venta enviada a caja</p>
                <h2>{sentSale.saleNumber ?? sentSale.id}</h2>
                <p>La venta quedo en estado PENDING_PAYMENT y ya puede cobrarla caja.</p>
              </div>
              <span className="state-pill">{sentSale.status}</span>
              <button className="secondary-button" onClick={startSale} disabled={actionLoading}>
                Nueva venta
              </button>
            </section>
          ) : null}

          {!sale ? (
            <div className="empty-sale">
              <h2>Abrir borrador de venta</h2>
              <p>Selecciona la sucursal autorizada y crea una venta DRAFT para cargar articulos.</p>
              <button
                className="primary-button"
                onClick={startSale}
                disabled={actionLoading || !branchId}
              >
                Abrir venta DRAFT
              </button>
            </div>
          ) : (
            <>
              <div className="sale-strip">
                <span>
                  Venta DRAFT <strong>{shortId(sale.id)}</strong>
                </span>
                <span>{saleItemCount} articulos</span>
                {demoReady ? <span className="demo-pill">Demo ARS 165.000 lista</span> : null}
              </div>

              <div className="product-grid">
                {catalogLoading ? (
                  <p className="muted">Cargando catalogo...</p>
                ) : variants.length === 0 ? (
                  <p className="muted">No hay variantes para esta busqueda o sucursal.</p>
                ) : (
                  variants.map((variant) => {
                    const stock = stockForBranch(variant);
                    const inCart = lineQuantityInSale(variant.id);
                    const canAdd = stock > inCart;

                    return (
                      <article className="product-card" key={variant.id}>
                        <div className="product-art">{variant.product.name.slice(0, 2).toUpperCase()}</div>
                        <div className="product-info">
                          <h3>{variant.product.name}</h3>
                          <p>{variantLabel(variant)}</p>
                          <small>{variant.sku}</small>
                        </div>
                        <div className="product-bottom">
                          <strong>{formatMoney(variant.price)}</strong>
                          <span className={stock > ZERO ? "stock" : "stock out"}>
                            {stock > ZERO ? `${stock.toString()} disponibles` : "Sin stock"}
                          </span>
                        </div>
                        {inCart > ZERO ? (
                          <p className="in-cart">{inCart.toString()} en venta actual</p>
                        ) : null}
                        <button
                          className="add-button"
                          onClick={() => addVariant(variant)}
                          disabled={actionLoading || !canAdd}
                        >
                          Agregar
                        </button>
                      </article>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>

        <aside className="cart-panel">
          <div className="cart-heading">
            <div>
              <p className="eyebrow">Carrito</p>
              <h2>Venta actual</h2>
            </div>
            <span className="cart-count">{saleItemCount}</span>
          </div>

          {!sale ? (
            <div className="cart-empty">
              <span>DRAFT</span>
              <p>No hay venta abierta</p>
              <small>Abre una venta para cargar productos.</small>
            </div>
          ) : (
            <>
              <div className="cart-items">
                {sale.items.length === 0 ? (
                  <p className="muted">Todavia no hay articulos en el carrito.</p>
                ) : (
                  sale.items.map((item) => (
                    <div className="cart-item" key={item.id}>
                      <div className="cart-item-copy">
                        <strong>{item.productName}</strong>
                        <span>
                          {item.variantName} | {item.sku}
                        </span>
                        <small>Unitario {formatMoney(item.unitPrice)}</small>
                      </div>
                      <div className="quantity-control" aria-label={`Cantidad ${item.productName}`}>
                        <button
                          onClick={() => updateItem(item, BigInt(item.quantity) - ONE)}
                          disabled={actionLoading}
                        >
                          -
                        </button>
                        <span>{item.quantity}</span>
                        <button
                          onClick={() => updateItem(item, BigInt(item.quantity) + ONE)}
                          disabled={actionLoading}
                        >
                          +
                        </button>
                      </div>
                      <strong>{formatMoney(item.subtotal)}</strong>
                      <button
                        className="remove-button"
                        onClick={() => updateItem(item, ZERO)}
                        disabled={actionLoading}
                        aria-label={`Eliminar ${item.productName}`}
                      >
                        x
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="totals">
                <div>
                  <span>Subtotal</span>
                  <strong>{formatMoney(sale.subtotal)}</strong>
                </div>
                <div>
                  <span>Descuentos</span>
                  <strong>{formatMoney(sale.discountTotal)}</strong>
                </div>
                <div className="total-line">
                  <span>Total</span>
                  <strong>{formatMoney(sale.total)}</strong>
                </div>
              </div>

              <button
                className="send-button"
                onClick={sendToCashier}
                disabled={actionLoading || sale.items.length === 0}
              >
                Enviar a caja
                <span>-&gt;</span>
              </button>
              <p className="cart-note">Al enviar, el backend valida y reserva stock.</p>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
