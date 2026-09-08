"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";

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

type SaleStatus = "DRAFT" | "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED";

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
  status: SaleStatus;
  subtotal: string;
  discountTotal: string;
  total: string;
  branch?: { id: string; name: string; code: string };
  seller?: { id: string; name: string; email: string };
  items: SaleItem[];
};

type PendingSale = {
  saleId: string;
  saleNumber: string | null;
  sellerName: string;
  items: SaleItem[];
  subtotal: string;
  total: string;
  paidAmount: string;
  remainingBalance: string;
};

type PaymentMethod = "CASH" | "TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT" | "QR";

type SalePayment = {
  id: string;
  saleId: string;
  method: PaymentMethod;
  amount: string;
  receivedAmount: string | null;
  changeAmount: string | null;
  cashSessionId: string | null;
  idempotencyKey: string;
  paidAt: string;
};

type CashRegister = {
  id: string;
  branchId: string;
  name: string;
};

type CashSession = {
  sessionId: string;
  registerId: string;
  branchId: string;
  openedById: string;
  closedById: string | null;
  startingCash: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  closingCash?: string;
};

type ApiError = { message?: string; error?: { message?: string } };
type PaymentIntent = {
  saleId: string;
  body: {
    method: PaymentMethod;
    amount: string;
    receivedAmount?: string | null;
    idempotencyKey: string;
  };
  label: string;
};

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

function cents(value: string) {
  return BigInt(value);
}

function formatMoney(value: string) {
  const pesos = cents(value) / ONE_HUNDRED;
  return money.format(Number(pesos));
}

function formatSignedMoney(value: string) {
  const amount = cents(value);
  return amount < ZERO ? `-${formatMoney((-amount).toString())}` : formatMoney(value);
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function toQuantity(value: string) {
  return Number(cents(value));
}

function variantLabel(variant: Pick<Variant, "color" | "size">) {
  return [variant.color, variant.size].filter(Boolean).join(" / ") || "Única";
}

function statusLabel(status: SaleStatus) {
  const labels: Record<SaleStatus, string> = {
    DRAFT: "Borrador",
    PENDING_PAYMENT: "Pendiente de pago",
    PAID: "Pagada",
    COMPLETED: "Completada",
    CANCELLED: "Cancelada",
  };
  return labels[status];
}

function paymentMethodLabel(method: PaymentMethod) {
  const labels: Record<PaymentMethod, string> = {
    CASH: "Efectivo",
    TRANSFER: "Transferencia",
    CARD_DEBIT: "Tarjeta de débito",
    CARD_CREDIT: "Tarjeta de crédito",
    QR: "QR",
  };
  return labels[method];
}

function roleLabel(role: string) {
  const labels: Record<string, string> = {
    SELLER: "Vendedor",
    CASHIER: "Cajero",
    MANAGER: "Gerente",
    ADMIN: "Administrador",
  };
  return labels[role] ?? role;
}

function userFacingError(message: string | undefined, fallback: string) {
  const labels: Record<string, string> = {
    Unauthorized: "No autorizado.",
    Forbidden: "No tenés permiso para realizar esta acción.",
    "Invalid credentials": "Usuario o contraseña incorrectos.",
  };
  return message ? (labels[message] ?? message) : fallback;
}

function arsToCents(input: string) {
  const normalized = input.trim().replace(/\s/g, "");
  if (!normalized) return null;
  if (!/^[0-9.,]+$/.test(normalized)) return null;

  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  const decimalIndex = comma > dot ? comma : dot;
  const hasDecimal = decimalIndex >= 0 && normalized.length - decimalIndex - 1 <= 2;

  const wholePart = hasDecimal ? normalized.slice(0, decimalIndex) : normalized;
  const decimalPart = hasDecimal ? normalized.slice(decimalIndex + 1) : "";
  const wholeDigits = wholePart.replace(/[.,]/g, "");

  if (!/^\d+$/.test(wholeDigits) || (decimalPart && !/^\d{1,2}$/.test(decimalPart))) {
    return null;
  }

  return (BigInt(wholeDigits) * ONE_HUNDRED + BigInt(decimalPart.padEnd(2, "0") || "0")).toString();
}

function centsToArsInput(value: string) {
  return (cents(value) / ONE_HUNDRED).toString();
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
    const apiError = body as ApiError;
    const fallback =
      response.status === 401
        ? "No autorizado."
        : response.status === 403
          ? "No tenés permiso para realizar esta acción."
          : "No se pudo completar la operación.";
    throw new Error(userFacingError(apiError.message ?? apiError.error?.message, fallback));
  }

  return body as T;
}

function hasRole(user: User, role: string) {
  return user.roles.includes(role);
}

export default function OperationsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("cashier01@demo.local");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [branchId, setBranchId] = useState("");
  const [mode, setMode] = useState<"seller" | "cashier">("cashier");
  const [authLoading, setAuthLoading] = useState(true);
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
        setMode(hasRole(currentUser, "CASHIER") ? "cashier" : "seller");
      })
      .catch(() => {
        window.localStorage.removeItem(TOKEN_KEY);
        setToken(null);
      })
      .finally(() => setAuthLoading(false));
  }, []);

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
      setMode(hasRole(result.user, "CASHIER") ? "cashier" : "seller");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo iniciar sesión.");
    } finally {
      setActionLoading(false);
    }
  }

  function logout() {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setBranchId("");
    setError("");
  }

  if (authLoading) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="brand-mark">MJ</div>
          <p className="eyebrow">Mona Jacinta Operaciones</p>
          <h1>Cargando sesión</h1>
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
          <p className="muted">Ingresá con tu usuario para operar ventas y caja.</p>

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
              Contraseña
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

  const canCashier = hasRole(user, "CASHIER") || hasRole(user, "MANAGER") || hasRole(user, "ADMIN");
  const canSeller = hasRole(user, "SELLER") || hasRole(user, "MANAGER") || hasRole(user, "ADMIN");

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

        <div className="mode-tabs" role="tablist" aria-label="Modo de operación">
          {canCashier ? (
            <button
              className={mode === "cashier" ? "mode-tab active" : "mode-tab"}
              onClick={() => setMode("cashier")}
            >
              Caja
            </button>
          ) : null}
          {canSeller ? (
            <button
              className={mode === "seller" ? "mode-tab active" : "mode-tab"}
              onClick={() => setMode("seller")}
            >
              Venta
            </button>
          ) : null}
        </div>

        <div className="user-menu">
          <span>
            {user.name}
            <small>{user.roles.map(roleLabel).join(" / ")}</small>
          </span>
          <button className="text-button" onClick={logout}>
            Salir
          </button>
        </div>
      </header>

      {mode === "cashier" ? (
        <CashierWorkspace
          token={token}
          user={user}
          branchId={branchId}
          onBranchChange={setBranchId}
        />
      ) : (
        <SellerWorkspace token={token} user={user} branchId={branchId} onBranchChange={setBranchId} />
      )}
    </main>
  );
}

function SellerWorkspace({
  token,
  user,
  branchId,
  onBranchChange,
}: {
  token: string | null;
  user: User;
  branchId: string;
  onBranchChange: (branchId: string) => void;
}) {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [sale, setSale] = useState<Sale | null>(null);
  const [sentSale, setSentSale] = useState<Sale | null>(null);
  const [search, setSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");

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
      (item) => item.productName === "Remera Basica" || item.productName === "Remera Basica",
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
    return cents(variant.inventory.find((item) => item.branchId === branchId)?.available ?? "0");
  }

  function lineQuantityInSale(variantId: string) {
    const item = sale?.items.find((candidate) => candidate.variantId === variantId);
    return cents(item?.quantity ?? "0");
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
      setError(cause instanceof Error ? cause.message : "No se pudo agregar el artículo.");
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
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar el artículo.");
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo enviar la venta a caja.");
    } finally {
      setActionLoading(false);
    }
  }

  function changeBranch(nextBranchId: string) {
    onBranchChange(nextBranchId);
    setSale(null);
    setSentSale(null);
    setError("");
  }

  return (
    <div className="workspace">
      <section className="catalog-column">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Venta vendedor</p>
            <h1>Productos y variantes</h1>
          </div>
          <span className="status-pill">Conectado</span>
        </div>

        <div className="toolbar">
          <BranchSelect
            value={branchId}
            branchIds={user.branchIds}
            disabled={actionLoading}
            onChange={changeBranch}
          />
          <label className="search-box">
            Buscar
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Producto, SKU, color, talle o código"
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
              <p>La venta quedó en estado pendiente de pago y ya puede cobrarla caja.</p>
            </div>
            <span className="state-pill">{statusLabel(sentSale.status)}</span>
            <button className="secondary-button" onClick={startSale} disabled={actionLoading}>
              Nueva venta
            </button>
          </section>
        ) : null}

        {!sale ? (
          <div className="empty-sale">
            <h2>Abrir borrador de venta</h2>
            <p>Seleccioná la sucursal autorizada y creá una venta en borrador para cargar artículos.</p>
            <button className="primary-button" onClick={startSale} disabled={actionLoading || !branchId}>
              Abrir venta
            </button>
          </div>
        ) : (
          <>
            <div className="sale-strip">
              <span>
                Venta en borrador <strong>{shortId(sale.id)}</strong>
              </span>
              <span>{saleItemCount} artículos</span>
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
                      {inCart > ZERO ? <p className="in-cart">{inCart.toString()} en venta actual</p> : null}
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
            <span>Borrador</span>
            <p>No hay venta abierta</p>
            <small>Abre una venta para cargar productos.</small>
          </div>
        ) : (
          <>
            <SaleItemsList
              items={sale.items}
              actionLoading={actionLoading}
              onDecrease={(item) => updateItem(item, cents(item.quantity) - ONE)}
              onIncrease={(item) => updateItem(item, cents(item.quantity) + ONE)}
              onRemove={(item) => updateItem(item, ZERO)}
            />
            <SaleTotals subtotal={sale.subtotal} discountTotal={sale.discountTotal} total={sale.total} />
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
  );
}

function CashierWorkspace({
  token,
  user,
  branchId,
  onBranchChange,
}: {
  token: string | null;
  user: User;
  branchId: string;
  onBranchChange: (branchId: string) => void;
}) {
  const [register, setRegister] = useState<CashRegister | null>(null);
  const [cashSession, setCashSession] = useState<CashSession | null>(null);
  const [pendingSales, setPendingSales] = useState<PendingSale[]>([]);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [selectedPayments, setSelectedPayments] = useState<SalePayment[]>([]);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [startingCash, setStartingCash] = useState("0");
  const [closingCash, setClosingCash] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [retryIntent, setRetryIntent] = useState<PaymentIntent | null>(null);
  const [loading, setLoading] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [completeLoading, setCompleteLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedSale = useMemo(
    () => pendingSales.find((sale) => sale.saleId === selectedSaleId) ?? null,
    [pendingSales, selectedSaleId],
  );
  const completedSnapshot = useMemo<PendingSale | null>(() => {
    if (!completedSale || completedSale.id !== selectedSaleId) return null;
    return {
      saleId: completedSale.id,
      saleNumber: completedSale.saleNumber,
      sellerName: completedSale.seller?.name ?? "Vendedor no informado",
      items: completedSale.items,
      subtotal: completedSale.subtotal,
      total: completedSale.total,
      paidAmount: completedSale.total,
      remainingBalance: "0",
    };
  }, [completedSale, selectedSaleId]);
  const displaySale = selectedSale ?? completedSnapshot;

  const paidAmount = useMemo(
    () => selectedPayments.reduce((sum, payment) => sum + cents(payment.amount), ZERO),
    [selectedPayments],
  );

  const saleTotal = displaySale ? cents(displaySale.total) : ZERO;
  const effectivePaidAmount = completedSnapshot ? saleTotal : paidAmount;
  const remaining = displaySale ? saleTotal - effectivePaidAmount : ZERO;
  const isPaid = Boolean(displaySale && saleTotal > ZERO && remaining === ZERO);
  const selectedStatus = completedSale?.id === selectedSaleId ? "COMPLETED" : isPaid ? "PAID" : "PENDING_PAYMENT";
  const cashReceivedCents = arsToCents(cashReceived);
  const paymentAmountCents = arsToCents(paymentAmount);
  const changeAmount =
    paymentMethod === "CASH" && cashReceivedCents && paymentAmountCents
      ? cents(cashReceivedCents) - cents(paymentAmountCents)
      : ZERO;

  const loadPayments = useCallback(
    async (saleId: string) => {
      if (!token) return;
      const response = await apiRequest<{ items: SalePayment[] }>(`/sales/${saleId}/payments`, token);
      setSelectedPayments(response.items);
    },
    [token],
  );

  const refreshQueue = useCallback(async () => {
    if (!token) return;
    const response = await apiRequest<{ items: PendingSale[] }>("/sales/pending", token);
    setPendingSales(response.items);
    setSelectedSaleId((current) => {
      if (current && response.items.some((sale) => sale.saleId === current)) return current;
      return response.items[0]?.saleId ?? current;
    });
  }, [token]);

  const refreshCash = useCallback(async () => {
    if (!token || !branchId) return;
    const query = new URLSearchParams({ branchId });
    const currentRegister = await apiRequest<CashRegister>(`/cash/register?${query.toString()}`, token);
    const currentSession = await apiRequest<CashSession | null>(`/cash/current?${query.toString()}`, token);
    setRegister(currentRegister);
    setCashSession(currentSession);
  }, [token, branchId]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await Promise.all([refreshCash(), refreshQueue()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar caja.");
    } finally {
      setLoading(false);
    }
  }, [refreshCash, refreshQueue]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedSaleId) {
      setSelectedPayments([]);
      return;
    }
    loadPayments(selectedSaleId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : "No se pudieron cargar los pagos."),
    );
  }, [selectedSaleId, loadPayments]);

  useEffect(() => {
    if (!token) return;
    const timer = window.setInterval(() => {
      refreshQueue().catch(() => undefined);
      if (selectedSaleId) loadPayments(selectedSaleId).catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [token, selectedSaleId, refreshQueue, loadPayments]);

  useEffect(() => {
    if (!selectedSale) return;
    const defaultAmount = remaining > ZERO ? remaining.toString() : selectedSale.remainingBalance;
    setPaymentAmount(centsToArsInput(defaultAmount));
    setCashReceived(centsToArsInput(defaultAmount));
    setCompletedSale(null);
    setRetryIntent(null);
    // Evita pisar importes escritos durante el refresco automatico de la cola.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSaleId]);

  async function openCashSession() {
    if (!token || !register) return;
    const amount = arsToCents(startingCash);
    if (!amount) {
      setError("Ingresá un monto inicial válido.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const session = await apiRequest<CashSession>("/cash/sessions/open", token, {
        method: "POST",
        body: JSON.stringify({ registerId: register.id, startingCash: amount }),
      });
      setCashSession(session);
      setNotice("Sesión de caja abierta.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir caja.");
    } finally {
      setLoading(false);
    }
  }

  async function closeCashSession() {
    if (!token || !cashSession) return;
    const amount = arsToCents(closingCash);
    if (!amount) {
      setError("Ingresá un monto de cierre válido.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const closed = await apiRequest<CashSession>(`/cash/sessions/${cashSession.sessionId}/close`, token, {
        method: "POST",
        body: JSON.stringify({ closingCash: amount }),
      });
      setCashSession(null);
      setNotice(`Caja cerrada con ${formatMoney(closed.closingCash ?? amount)}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cerrar caja.");
    } finally {
      setLoading(false);
    }
  }

  async function submitPayment(intent: PaymentIntent) {
    if (!token) return;
    setPaymentLoading(true);
    setError("");
    setNotice("");

    try {
      await apiRequest<SalePayment>(`/sales/${intent.saleId}/payments`, token, {
        method: "POST",
        body: JSON.stringify(intent.body),
      });
      setRetryIntent(null);
      await loadPayments(intent.saleId);
      await refreshQueue();
      setNotice(`${intent.label} registrado.`);
    } catch (cause) {
      setRetryIntent(intent);
      setError(cause instanceof Error ? cause.message : "No se pudo registrar el pago.");
    } finally {
      setPaymentLoading(false);
    }
  }

  async function registerPayment() {
    if (!selectedSale) return;
    const amount = arsToCents(paymentAmount);
    const received = paymentMethod === "CASH" ? arsToCents(cashReceived) : null;

    if (!amount || cents(amount) <= ZERO) {
      setError("Ingresá un importe de pago válido.");
      return;
    }
    if (cents(amount) > remaining) {
      setError("El importe supera el saldo pendiente.");
      return;
    }
    if (paymentMethod === "CASH" && (!received || cents(received) < cents(amount))) {
      setError("El efectivo recibido no puede ser menor al importe.");
      return;
    }

    const intent: PaymentIntent = {
      saleId: selectedSale.saleId,
      body: {
        method: paymentMethod,
        amount,
        receivedAmount: paymentMethod === "CASH" ? received : null,
        idempotencyKey: crypto.randomUUID(),
      },
      label: `${paymentMethodLabel(paymentMethod)} ${formatMoney(amount)}`,
    };

    await submitPayment(intent);
  }

  async function completeSale() {
    if (!token || !selectedSale || !isPaid) return;
    setCompleteLoading(true);
    setError("");
    setNotice("");

    try {
      const completed = await apiRequest<Sale>(`/sales/${selectedSale.saleId}/complete`, token, {
        method: "POST",
      });
      setCompletedSale(completed);
      setNotice(`Venta ${completed.saleNumber ?? completed.id} completada.`);
      await refreshQueue();
      setSelectedPayments([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la venta.");
    } finally {
      setCompleteLoading(false);
    }
  }

  function changeBranch(nextBranchId: string) {
    onBranchChange(nextBranchId);
    setSelectedSaleId(null);
    setSelectedPayments([]);
    setCompletedSale(null);
    setError("");
    setNotice("");
  }

  return (
    <div className="cashier-workspace">
      <section className="queue-column">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Caja</p>
            <h1>Ventas pendientes</h1>
          </div>
          <button className="secondary-button" onClick={refreshAll} disabled={loading}>
            Actualizar
          </button>
        </div>

        <div className="toolbar">
          <BranchSelect
            value={branchId}
            branchIds={user.branchIds}
            disabled={loading || paymentLoading || completeLoading}
            onChange={changeBranch}
          />
        </div>

        <CashSessionPanel
          register={register}
          session={cashSession}
          startingCash={startingCash}
          closingCash={closingCash}
          loading={loading}
          onStartingCashChange={setStartingCash}
          onClosingCashChange={setClosingCash}
          onOpen={openCashSession}
          onClose={closeCashSession}
        />

        {error ? <p className="error-banner">{error}</p> : null}
        {notice ? <p className="notice-banner">{notice}</p> : null}

        <div className="queue-list">
          {loading && pendingSales.length === 0 ? (
            <p className="muted">Cargando cola...</p>
          ) : pendingSales.length === 0 ? (
            <div className="queue-empty">
              <h2>Sin ventas pendientes</h2>
              <p>No hay ventas pendientes de pago para el alcance autorizado actual.</p>
            </div>
          ) : (
            pendingSales.map((sale) => (
              <button
                key={sale.saleId}
                className={selectedSaleId === sale.saleId ? "queue-card active" : "queue-card"}
                onClick={() => setSelectedSaleId(sale.saleId)}
              >
                <span>
                  <strong>{sale.saleNumber ?? shortId(sale.saleId)}</strong>
                  <small>{sale.sellerName || "Vendedor no informado"}</small>
                </span>
                <span>
                  <strong>{formatMoney(sale.total)}</strong>
                  <small>{formatSignedMoney(sale.remainingBalance)} pendiente</small>
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="cashier-detail">
        {!displaySale ? (
          <div className="detail-empty">
            <span>Pendiente de pago</span>
            <h2>Seleccioná una venta</h2>
            <p>La venta seleccionada mostrará artículos, pagos y saldo restante.</p>
          </div>
        ) : (
          <>
            <div className="detail-header">
              <div>
                <p className="eyebrow">Venta seleccionada</p>
                <h2>{displaySale.saleNumber ?? shortId(displaySale.saleId)}</h2>
                <p>{displaySale.sellerName || "Vendedor no informado"}</p>
              </div>
              <span className={selectedStatus === "PAID" || selectedStatus === "COMPLETED" ? "paid-pill" : "state-pill"}>
                {statusLabel(selectedStatus)}
              </span>
            </div>

            <div className="remaining-card">
              <span>Saldo pendiente</span>
              <strong>{formatSignedMoney(remaining.toString())}</strong>
            </div>

            <div className="detail-grid">
              <section>
                <h3>Artículos</h3>
                <div className="readonly-items">
                  {displaySale.items.length === 0 ? (
                    <p className="muted">La venta no contiene artículos.</p>
                  ) : (
                    displaySale.items.map((item) => (
                      <div className="readonly-item" key={item.id}>
                        <span>
                          <strong>{item.productName}</strong>
                          <small>
                            {item.variantName} | {item.sku}
                          </small>
                        </span>
                        <span>{item.quantity} x {formatMoney(item.unitPrice)}</span>
                        <strong>{formatMoney(item.subtotal)}</strong>
                      </div>
                    ))
                  )}
                </div>
                <SaleTotals subtotal={displaySale.subtotal} discountTotal="0" total={displaySale.total} />
              </section>

              <section>
                <h3>Pagos</h3>
                <div className="payments-list">
                  {selectedPayments.length === 0 ? (
                    <p className="muted">Todavía no hay pagos registrados.</p>
                  ) : (
                    selectedPayments.map((payment) => (
                      <div className="payment-row" key={payment.id}>
                        <span>
                          <strong>{paymentMethodLabel(payment.method)}</strong>
                          <small>{payment.idempotencyKey}</small>
                        </span>
                        <span>
                          <strong>{formatMoney(payment.amount)}</strong>
                          {payment.method === "CASH" ? (
                            <small>
                              Recibido {formatMoney(payment.receivedAmount ?? "0")} | Vuelto{" "}
                              {formatMoney(payment.changeAmount ?? "0")}
                            </small>
                          ) : null}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </section>

      <aside className="payment-panel">
        <div className="cart-heading">
          <div>
            <p className="eyebrow">Cobro</p>
            <h2>Registrar pago</h2>
          </div>
        </div>

        {!displaySale ? (
          <div className="cart-empty">
            <span>Cobro</span>
            <p>Sin venta seleccionada</p>
            <small>Seleccioná una venta pendiente para cobrar.</small>
          </div>
        ) : (
          <>
            <div className="payment-summary">
              <div>
                <span>Total</span>
                <strong>{formatMoney(displaySale.total)}</strong>
              </div>
              <div>
                <span>Pagado</span>
                <strong>{formatMoney(effectivePaidAmount.toString())}</strong>
              </div>
              <div className="total-line">
                <span>Pendiente</span>
                <strong>{formatSignedMoney(remaining.toString())}</strong>
              </div>
            </div>

            <label>
              Método
              <select
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
                disabled={paymentLoading || isPaid}
              >
                <option value="CASH">Efectivo</option>
                <option value="TRANSFER">Transferencia</option>
                <option value="CARD_DEBIT">Tarjeta de débito</option>
                <option value="CARD_CREDIT">Tarjeta de crédito</option>
                <option value="QR">QR</option>
              </select>
            </label>

            <label>
              Importe ARS
              <input
                inputMode="decimal"
                value={paymentAmount}
                onChange={(event) => setPaymentAmount(event.target.value)}
                disabled={paymentLoading || isPaid}
                placeholder="65000"
              />
            </label>

            {paymentMethod === "CASH" ? (
              <>
                <label>
                  Recibido ARS
                  <input
                    inputMode="decimal"
                    value={cashReceived}
                    onChange={(event) => setCashReceived(event.target.value)}
                    disabled={paymentLoading || isPaid}
                    placeholder="100000"
                  />
                </label>
                <div className="change-box">
                  <span>Vuelto</span>
                  <strong>{changeAmount > ZERO ? formatMoney(changeAmount.toString()) : formatMoney("0")}</strong>
                </div>
              </>
            ) : null}

            {retryIntent ? (
              <button
                className="secondary-button retry-button"
                onClick={() => submitPayment(retryIntent)}
                disabled={paymentLoading}
              >
                Reintentar mismo pago
              </button>
            ) : null}

            <button
              className="send-button"
              onClick={registerPayment}
              disabled={
                paymentLoading ||
                completeLoading ||
                isPaid ||
                selectedStatus === "COMPLETED" ||
                remaining <= ZERO ||
                (paymentMethod === "CASH" && !cashSession)
              }
            >
              {paymentLoading ? "Registrando..." : "Registrar pago"}
              <span>-&gt;</span>
            </button>

            {paymentMethod === "CASH" && !cashSession ? (
              <p className="cart-note">Abre caja antes de registrar pagos en efectivo.</p>
            ) : (
              <p className="cart-note">Cada nuevo intento genera un UUID v4 de idempotencia.</p>
            )}

            <button
              className="complete-button"
              onClick={completeSale}
              disabled={!isPaid || selectedStatus === "COMPLETED" || completeLoading || paymentLoading}
            >
              {completeLoading ? "Finalizando..." : "Finalizar venta"}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}

function BranchSelect({
  value,
  branchIds,
  disabled,
  onChange,
}: {
  value: string;
  branchIds: string[];
  disabled: boolean;
  onChange: (branchId: string) => void;
}) {
  return (
    <label className="branch-select">
      Sucursal autorizada
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={branchIds.length === 0 || disabled}
      >
        {branchIds.map((id) => (
          <option key={id} value={id}>
            {shortId(id)}
          </option>
        ))}
      </select>
    </label>
  );
}

function SaleItemsList({
  items,
  actionLoading,
  onDecrease,
  onIncrease,
  onRemove,
}: {
  items: SaleItem[];
  actionLoading: boolean;
  onDecrease: (item: SaleItem) => void;
  onIncrease: (item: SaleItem) => void;
  onRemove: (item: SaleItem) => void;
}) {
  return (
    <div className="cart-items">
      {items.length === 0 ? (
        <p className="muted">Todavía no hay artículos en el carrito.</p>
      ) : (
        items.map((item) => (
          <div className="cart-item" key={item.id}>
            <div className="cart-item-copy">
              <strong>{item.productName}</strong>
              <span>
                {item.variantName} | {item.sku}
              </span>
              <small>Unitario {formatMoney(item.unitPrice)}</small>
            </div>
            <div className="quantity-control" aria-label={`Cantidad ${item.productName}`}>
              <button onClick={() => onDecrease(item)} disabled={actionLoading}>
                -
              </button>
              <span>{item.quantity}</span>
              <button onClick={() => onIncrease(item)} disabled={actionLoading}>
                +
              </button>
            </div>
            <strong>{formatMoney(item.subtotal)}</strong>
            <button
              className="remove-button"
              onClick={() => onRemove(item)}
              disabled={actionLoading}
              aria-label={`Eliminar ${item.productName}`}
            >
              x
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function SaleTotals({
  subtotal,
  discountTotal,
  total,
}: {
  subtotal: string;
  discountTotal: string;
  total: string;
}) {
  return (
    <div className="totals">
      <div>
        <span>Subtotal</span>
        <strong>{formatMoney(subtotal)}</strong>
      </div>
      <div>
        <span>Descuentos</span>
        <strong>{formatMoney(discountTotal)}</strong>
      </div>
      <div className="total-line">
        <span>Total</span>
        <strong>{formatMoney(total)}</strong>
      </div>
    </div>
  );
}

function CashSessionPanel({
  register,
  session,
  startingCash,
  closingCash,
  loading,
  onStartingCashChange,
  onClosingCashChange,
  onOpen,
  onClose,
}: {
  register: CashRegister | null;
  session: CashSession | null;
  startingCash: string;
  closingCash: string;
  loading: boolean;
  onStartingCashChange: (value: string) => void;
  onClosingCashChange: (value: string) => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <section className={session ? "cash-session open" : "cash-session"}>
      <div>
        <p className="eyebrow">Estado de caja</p>
        <h2>{session ? "Caja abierta" : "Caja cerrada"}</h2>
        <p>{register ? register.name : "Buscando caja de la sucursal..."}</p>
      </div>
      {session ? (
        <div className="cash-controls">
          <label>
            Cierre ARS
            <input
              inputMode="decimal"
              value={closingCash}
              onChange={(event) => onClosingCashChange(event.target.value)}
              disabled={loading}
            />
          </label>
          <button className="secondary-button" onClick={onClose} disabled={loading}>
            Cerrar caja
          </button>
        </div>
      ) : (
        <div className="cash-controls">
          <label>
            Inicial ARS
            <input
              inputMode="decimal"
              value={startingCash}
              onChange={(event) => onStartingCashChange(event.target.value)}
              disabled={loading || !register}
            />
          </label>
          <button className="primary-button" onClick={onOpen} disabled={loading || !register}>
            Abrir caja
          </button>
        </div>
      )}
    </section>
  );
}
