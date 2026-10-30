"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { catalogCashPrice } from "./catalog-price";
import ProportionalChargePanel from "./ProportionalChargePanel";
import { apiRequest, apiRequestCoded } from "../lib/api";
import { ONE, ZERO, arsToCents, cents, centsToArsInput, formatMoney, formatSignedMoney } from "../lib/money";
import BranchSelect from "./BranchSelect";
import ExchangeWorkspace, { exchangeAuthorizedBranchIds } from "./ExchangeWorkspace";
import { exchangeDrafts } from "./exchange-draft-store";
import WarehouseWorkspace from "./WarehouseWorkspace";
import type { ProductionCheckoutAttempt } from "./checkout-quote";

type User = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  branchIds: string[];
  permissions: string[];
  // CLIENT-CASH-UX (2026-10-19): branch-aware UI hints computed server-side by
  // /auth/me (see api/src/modules/auth/user-context.dto.ts). THIS IS NOT
  // AUTHORIZATION: endpoints keep enforcing hasPermissionAtLocation and the
  // supervisor rule server-side. The client only decides visibility per
  // ACTIVE branch: activeBranchId ∈ cashMovementLocationIds → movements
  // panel/Gasto/Historial; activeBranchId ∈ cashSupervisorLocationIds →
  // Retiro/Corregir (OWNER, or an ADMIN with COMPANY reach, only).
  cashMovementLocationIds: string[];
  cashSupervisorLocationIds: string[];
  // WAREHOUSE-MVP: same kind of hint for the Depósito module — the branches where
  // INVENTORY_MANAGE is effective. Absent on an API that predates it. The
  // endpoints stay authoritative; the client never derives it from the role.
  inventoryManageLocationIds?: string[];
  // Display labels (id, name, code) for the selector, for the user's effective branches only. Never authority: the options come from
  // branchIds. Absent on an API that predates it (the selector then shows the short id).
  branches?: Array<{ id: string; name: string; code: string }>;
  // Sale exchange v1: where the caller is the exchange supervisor (api user-context.dto.ts). A visibility hint for the future Cambios
  // tab; POST /sales/:saleId/exchanges stays authoritative. Absent on an API that predates it.
  saleExchangeLocationIds?: string[];
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
  cashPrice: string | null;
  price: string;
  isActive: boolean;
  product: { id: string; name: string; slug: string };
  inventory: Inventory[];
};

type SaleStatus = "DRAFT" | "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED";

// Block 1: the server decides and stores the price mode; the client only
// renders it. LIST is the ordinary price; WHOLESALE is sale-scoped.
type PricingMode = "LIST" | "WHOLESALE";
type PriceMode = "CASH" | "LIST" | "CREDIT_CARD" | "DEBIT_CARD" | "BANK_TRANSFER" | "QR";
// R3-A4.2b: the settlement circuit the server persists on the sale. The POS
// reads it and never infers it: a PROPORTIONAL_V1 sale is charged by its own
// checkout circuit, and `checkoutRequired` is the routing artifact.
type PricingModel = "FIXED_TOTAL" | "PROPORTIONAL_V1";

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
  pricingMode?: PricingMode;
  priceMode?: PriceMode;
  branch?: { id: string; name: string; code: string };
  seller?: { id: string; name: string; email: string };
  items: SaleItem[];
};

// Pilot P0.1-C: informational hold state from GET /sales/pending. The server
// payment/completion transactions stay authoritative.
type HoldState = "VALID" | "EXPIRED" | "PAYMENT_PROTECTED" | "PAID" | "COVERAGE_INVALID";

type PendingSale = {
  saleId: string;
  saleNumber: string | null;
  sellerName: string;
  status?: SaleStatus;
  items: SaleItem[];
  subtotal: string;
  total: string;
  paidAmount: string;
  remainingBalance: string;
  holdState?: HoldState;
  canAcceptPayment?: boolean;
  // Pilot P0.2-C: informational eligibility for the current cashier. The
  // /correct and /cancel transactions stay authoritative.
  paymentCount?: number;
  canCorrect?: boolean;
  canCancel?: boolean;
  // Block 1: stored wholesale state; confirmWholesale stays authoritative.
  pricingMode?: PricingMode;
  priceMode?: PriceMode;
  wholesaleConfirmed?: boolean;
  canConfirmWholesale?: boolean;
  // R3-A4.2b: persisted settlement circuit. Both fields are required by the
  // queue parser and must be coherent: an absent model (or a pair that
  // contradicts itself) would silently route a proportional sale through the
  // historical payment path, so the whole queue fails closed instead.
  pricingModel: PricingModel;
  checkoutRequired: boolean;
};

type CancellationReason = "WRONG_ITEM" | "WRONG_QUANTITY" | "CUSTOMER_CHANGED_MIND" | "DUPLICATE_SALE" | "OTHER";

const CANCELLATION_REASONS: Array<{ value: CancellationReason; label: string }> = [
  { value: "WRONG_ITEM", label: "Artículo equivocado" },
  { value: "WRONG_QUANTITY", label: "Cantidad equivocada" },
  { value: "CUSTOMER_CHANGED_MIND", label: "El cliente desistió" },
  { value: "DUPLICATE_SALE", label: "Venta duplicada" },
  { value: "OTHER", label: "Otro motivo" },
];

type CorrectionLine = { variantId: string; productName: string; variantName: string; quantity: string };

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
  // CASH-1: server-side reconciliation of the close. Nullable by design:
  // sessions closed before CASH-1 (and none other) carry no reconciliation
  // and are never presented as reconciled.
  expectedCash?: string | null;
  countedCash?: string | null;
  difference?: string | null;
};

type CashMovementKind = "WITHDRAWAL" | "EXPENSE";
// PILOT reversal (migration 11): the append-only correction of a WITHDRAWAL / EXPENSE.
type CashMovementReversalType = "WITHDRAWAL_REVERSAL" | "EXPENSE_REVERSAL";
type CashMovementType = "OPENING" | "SALE_INCOME" | "CLOSING" | "MANUAL" | CashMovementKind | CashMovementReversalType;

type CashMovement = {
  id: string;
  sessionId: string;
  type: CashMovementType;
  amount: string;
  salePaymentId: string | null;
  userId: string;
  reason: string | null;
  idempotencyKey: string | null;
  reversesMovementId: string | null;
  timestamp: string;
};

type CashMovementIntent = {
  sessionId: string;
  kind: CashMovementKind;
  amount: string;
  reason: string;
  idempotencyKey: string;
};

// A confirmed correction: its key is minted once and reused by every retry.
type CashReversalIntent = {
  sessionId: string;
  movementId: string;
  reason: string;
  idempotencyKey: string;
};

type PaymentIntent = {
  saleId: string;
  body: {
    method: PaymentMethod;
    amount: string;
    receivedAmount?: string | null;
    idempotencyKey: string;
  };
  label: string;
  // The sale's own reference, to name it if another sale is selected meanwhile.
  saleRef: string;
};

const TOKEN_KEY = "mona-jacinta-token";
// R3-A4.2b: las herramientas de dinero y de fecha del POS, pasadas al panel
// proporcional como valor. El panel no reimplementa ninguna.
const MONEY_TOOLS = {
  parse: arsToCents,
  prefill: centsToArsInput,
  format: formatMoney,
  formatInstant: formatDateTime,
};

// CASH-1.1: shape check for one close row (history entry or close answer).
// The server is authoritative; this only keeps a malformed payload from
// breaking render or being shown as an invented amount. Money is integer
// centavos as a decimal string: counted/expected/closing are non-negative,
// the difference may be negative; null/absent means "not recorded".
const UNSIGNED_CENTS = /^\d+$/;
const SIGNED_CENTS = /^-?\d+$/;

function isOptionalCents(value: unknown, pattern: RegExp) {
  return value === null || value === undefined || (typeof value === "string" && pattern.test(value));
}

function isCashSessionEntry(value: unknown): value is CashSession {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sessionId === "string"
    && (entry.closedAt === null || entry.closedAt === undefined || typeof entry.closedAt === "string")
    && isOptionalCents(entry.countedCash, UNSIGNED_CENTS)
    && isOptionalCents(entry.expectedCash, UNSIGNED_CENTS)
    && isOptionalCents(entry.closingCash, UNSIGNED_CENTS)
    && isOptionalCents(entry.difference, SIGNED_CENTS);
}

// M1: a 200 answer whose shape breaks the contract. Kept apart from network
// and HTTP failures: an invalid answer is never written into state (fail
// closed) and what was shown for that resource is withdrawn, while a network
// failure keeps the last validated state of the same resource.
class InvalidResponseError extends Error {}

// GET /sales/pending only ever lists sales waiting for the cashier.
const QUEUE_STATUSES = new Set<unknown>(["PENDING_PAYMENT", "PAID"]);
const HOLD_STATES = new Set<unknown>(["VALID", "EXPIRED", "PAYMENT_PROTECTED", "PAID", "COVERAGE_INVALID"]);
const PRICING_MODES = new Set<unknown>(["LIST", "WHOLESALE"]);
const PRICE_MODES = new Set<unknown>(["CASH", "LIST", "CREDIT_CARD", "DEBIT_CARD", "BANK_TRANSFER", "QR"]);
const PRICING_MODELS = new Set<unknown>(["FIXED_TOTAL", "PROPORTIONAL_V1"]);
const PAYMENT_METHODS = new Set<unknown>(["CASH", "TRANSFER", "CARD_DEBIT", "CARD_CREDIT", "QR"]);
const CASH_MOVEMENT_TYPES = new Set<unknown>([
  "OPENING", "SALE_INCOME", "CLOSING", "MANUAL", "WITHDRAWAL", "EXPENSE", "WITHDRAWAL_REVERSAL", "EXPENSE_REVERSAL",
]);
const CASH_REVERSAL_TYPES = new Set<unknown>(["WITHDRAWAL_REVERSAL", "EXPENSE_REVERSAL"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCents(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value);
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value !== "";
}

function isSaleItem(value: unknown): value is SaleItem {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.variantId)
    && ["productName", "variantName", "sku"].every((key) => typeof value[key] === "string")
    && isCents(value.quantity, POSITIVE_INTEGER)
    && isCents(value.unitPrice, UNSIGNED_CENTS)
    && isCents(value.subtotal, UNSIGNED_CENTS);
}

function isPendingSale(value: unknown): value is PendingSale {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.saleId)
    && (value.saleNumber === null || typeof value.saleNumber === "string")
    && typeof value.sellerName === "string"
    && Array.isArray(value.items) && value.items.every(isSaleItem)
    && isCents(value.subtotal, UNSIGNED_CENTS)
    && isCents(value.total, UNSIGNED_CENTS)
    && isCents(value.paidAmount, UNSIGNED_CENTS)
    && isCents(value.remainingBalance, SIGNED_CENTS)
    && QUEUE_STATUSES.has(value.status)
    && HOLD_STATES.has(value.holdState)
    && PRICING_MODES.has(value.pricingMode)
    && PRICE_MODES.has(value.priceMode)
    && PRICING_MODELS.has(value.pricingModel)
    && typeof value.checkoutRequired === "boolean"
    // La coherencia va en el parser: cada modelo tiene un único circuito.
    && value.checkoutRequired === (value.pricingModel === "PROPORTIONAL_V1")
    && Number.isSafeInteger(value.paymentCount) && (value.paymentCount as number) >= 0
    && ["canAcceptPayment", "canCorrect", "canCancel", "wholesaleConfirmed", "canConfirmWholesale"]
      .every((key) => typeof value[key] === "boolean");
}

function isSalePayment(value: unknown, saleId: string): value is SalePayment {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && value.saleId === saleId
    && PAYMENT_METHODS.has(value.method)
    && isNonEmptyString(value.idempotencyKey)
    && (value.cashSessionId === null || isNonEmptyString(value.cashSessionId))
    && isNonEmptyString(value.paidAt)
    && isCents(value.amount, UNSIGNED_CENTS)
    && (value.receivedAmount === null || isCents(value.receivedAmount, UNSIGNED_CENTS))
    && (value.changeAmount === null || isCents(value.changeAmount, UNSIGNED_CENTS));
}

// Every field the API always sends is required: an absent canAcceptPayment
// or priceMode would silently lift a payment restriction.
// The whole answer is rejected when any row is invalid: silently dropping a
// row would hide a pending sale (or a payment) behind a plausible list.
function parsePendingSales(body: unknown): PendingSale[] {
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every(isPendingSale)) {
    throw new InvalidResponseError("La cola de ventas recibida del servidor no es válida. Reintentá con Actualizar.");
  }
  return body.items;
}

function parseSalePayments(body: unknown, saleId: string): SalePayment[] {
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every((item) => isSalePayment(item, saleId))) {
    throw new InvalidResponseError("Los pagos recibidos del servidor no son válidos.");
  }
  return body.items;
}

function isCashMovement(value: unknown, sessionId: string): value is CashMovement {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && value.sessionId === sessionId
    && CASH_MOVEMENT_TYPES.has(value.type)
    && isCents(value.amount, UNSIGNED_CENTS)
    && (value.salePaymentId === null || isNonEmptyString(value.salePaymentId))
    && isNonEmptyString(value.userId)
    && (value.reason === null || typeof value.reason === "string")
    && (value.idempotencyKey === null || isNonEmptyString(value.idempotencyKey))
    // A reversal always names its original; no other movement ever does.
    && (CASH_REVERSAL_TYPES.has(value.type)
      ? isNonEmptyString(value.reversesMovementId)
      : value.reversesMovementId === null || value.reversesMovementId === undefined)
    && isNonEmptyString(value.timestamp);
}

function parseCashMovements(body: unknown, sessionId: string): CashMovement[] {
  if (!Array.isArray(body) || !body.every((movement) => isCashMovement(movement, sessionId))) {
    throw new InvalidResponseError("Los movimientos de caja recibidos del servidor no son válidos.");
  }
  return body.map((movement: CashMovement) => ({ ...movement, reversesMovementId: movement.reversesMovementId ?? null }));
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "fecha no informada" : date.toLocaleString("es-AR");
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

function cashMovementLabel(type: CashMovementType) {
  const labels: Record<CashMovementType, string> = {
    OPENING: "Apertura",
    SALE_INCOME: "Ingreso por venta",
    CLOSING: "Cierre",
    MANUAL: "Ajuste anterior",
    WITHDRAWAL: "Retiro",
    EXPENSE: "Gasto",
    WITHDRAWAL_REVERSAL: "Reversión de retiro",
    EXPENSE_REVERSAL: "Reversión de gasto",
  };
  return labels[type];
}

// Display-only mirror of the server's payment/price-mode compatibility (the
// API stays authoritative and rejects a conflicting method). LIST has no
// single method twin, so it constrains nothing.
const PRICE_MODE_METHOD: Partial<Record<PriceMode, PaymentMethod>> = {
  CASH: "CASH",
  BANK_TRANSFER: "TRANSFER",
  DEBIT_CARD: "CARD_DEBIT",
  CREDIT_CARD: "CARD_CREDIT",
  QR: "QR",
};

function priceModeLabel(mode: PriceMode | undefined) {
  const labels: Record<PriceMode, string> = {
    CASH: "Efectivo",
    LIST: "Lista",
    CREDIT_CARD: "Tarjeta crédito",
    DEBIT_CARD: "Tarjeta débito",
    BANK_TRANSFER: "Transferencia",
    QR: "QR",
  };
  return mode ? labels[mode] : "Efectivo";
}

function roleLabel(role: string) {
  const labels: Record<string, string> = {
    OWNER: "Dueño",
    ADMIN: "Administrador",
    CASHIER: "Cajero",
    SELLER: "Vendedor",
    WAREHOUSE: "Depósito",
    // MANAGER is legacy-only display compatibility — it never participates
    // in Production POS access logic (see resolvePosAccess above).
    MANAGER: "Gerente",
  };
  return labels[role] ?? role;
}

type PosMode = "seller" | "cashier" | "warehouse" | "exchange" | null;

// D1 (Phase 1 Global Closeout): single, shared POS access policy — owns
// canSeller/canCashier/initialMode for BOTH the restored-session (/auth/me)
// path and the fresh-login path, so the two can never drift. A WAREHOUSE-only
// user (no SALE_CREATE/SALE_CHARGE — role-permission-matrix.ts) must never
// reach the sale or cash workspaces. OWNER/ADMIN are deliberately privileged
// (both workspaces, seller default) per the frozen POS access policy; legacy
// MANAGER never participates here — only current Production role codes reach
// `user.roles` (see user-context.dto.ts's D1 projection from context.assignments).
//
// WAREHOUSE-MVP: Depósito is gated by the branch-aware hint
// user.inventoryManageLocationIds (INVENTORY_MANAGE effective at a location),
// NOT by a role name: a pure WAREHOUSE starts there, OWNER/ADMIN/CASHIER/SELLER
// keep their own default and only get the extra tab when the hint is non-empty.
function resolvePosAccess(user: Pick<User, "roles" | "inventoryManageLocationIds" | "branchIds" | "saleExchangeLocationIds">): {
  canSeller: boolean;
  canCashier: boolean;
  canWarehouse: boolean;
  canExchange: boolean;
  exchangeBranchIds: string[];
  initialMode: PosMode;
} {
  const roles = user.roles;
  const isPrivileged = roles.includes("OWNER") || roles.includes("ADMIN");
  const hasCashier = roles.includes("CASHIER");
  const hasSeller = roles.includes("SELLER");

  const canSeller = isPrivileged || hasSeller;
  const canCashier = isPrivileged || hasCashier;
  const canWarehouse = (user.inventoryManageLocationIds ?? []).length > 0;
  // Cambios: the branches where the caller is the exchange supervisor AND that are among its own. Never initial: it is chosen.
  const exchangeBranchIds = exchangeAuthorizedBranchIds(user);
  const canExchange = exchangeBranchIds.length > 0;

  let initialMode: PosMode;
  if (isPrivileged) initialMode = "seller";
  else if (hasCashier) initialMode = "cashier";
  else if (hasSeller) initialMode = "seller";
  else if (canWarehouse) initialMode = "warehouse";
  else initialMode = null;

  return { canSeller, canCashier, canWarehouse, canExchange, exchangeBranchIds, initialMode };
}

export default function OperationsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [branchId, setBranchId] = useState("");
  const [mode, setMode] = useState<PosMode>(null);
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
        setMode(resolvePosAccess(currentUser).initialMode);
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
      setMode(resolvePosAccess(result.user).initialMode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo iniciar sesión.");
    } finally {
      setActionLoading(false);
    }
  }

  function endSession() {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setBranchId("");
    setMode(null);
    setError("");
  }

  // Logout and session expiry alike: end the session but NEVER destroy a Cambios attempt whose outcome is unknown (SENDING / UNCERTAIN).
  // If the request committed on the server and the answer was lost, forgetting its idempotencyKey would let the operator send the same
  // exchange again with a NEW key and, while units remain, exchange twice. The attempt stays in localStorage tied to its userId: only
  // that user can see and retry it (same payload, same key) after logging in again. Only editable drafts are dropped.
  function logout() {
    exchangeDrafts.dropEditable();
    endSession();
  }

  // The API answered 401 mid-operation: end the session and say why on the login screen.
  function sessionExpired() {
    logout();
    setError("Tu sesión expiró. Ingresá nuevamente.");
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
            {error ? <p className="error-banner" role="alert">{error}</p> : null}
            <button className="primary-button" disabled={actionLoading}>
              {actionLoading ? "Ingresando..." : "Ingresar"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  const { canSeller, canCashier, canWarehouse, canExchange, exchangeBranchIds } = resolvePosAccess(user);

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

        {/* Toggle buttons (aria-pressed), not role="tab": the tab roles would make five existing test files query the controls as "tab" instead
            of "button", churn with no operational benefit for a three-button mode switch. */}
        <div className="mode-tabs" role="group" aria-label="Modo de operación">
          {canCashier ? (
            <button
              className={mode === "cashier" ? "mode-tab active" : "mode-tab"}
              aria-pressed={mode === "cashier"}
              onClick={() => setMode("cashier")}
            >
              Caja
            </button>
          ) : null}
          {canSeller ? (
            <button
              className={mode === "seller" ? "mode-tab active" : "mode-tab"}
              aria-pressed={mode === "seller"}
              onClick={() => setMode("seller")}
            >
              Venta
            </button>
          ) : null}
          {canWarehouse ? (
            <button
              className={mode === "warehouse" ? "mode-tab active" : "mode-tab"}
              aria-pressed={mode === "warehouse"}
              onClick={() => setMode("warehouse")}
            >
              Depósito
            </button>
          ) : null}
          {canExchange ? (
            <button
              className={mode === "exchange" ? "mode-tab active" : "mode-tab"}
              aria-pressed={mode === "exchange"}
              onClick={() => setMode("exchange")}
            >
              Cambios
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
      ) : mode === "seller" ? (
        <SellerWorkspace token={token} user={user} branchId={branchId} onBranchChange={setBranchId} />
      ) : mode === "warehouse" ? (
        <WarehouseWorkspace
          token={token}
          userId={user.id}
          branchIds={user.inventoryManageLocationIds ?? []}
          onSessionExpired={sessionExpired}
        />
      ) : mode === "exchange" ? (
        <ExchangeWorkspace token={token} userId={user.id} branchIds={exchangeBranchIds} labels={user.branches} onSessionExpired={sessionExpired} />
      ) : (
        <section className="empty-card">
          <h1>Sin acceso al punto de venta</h1>
          <p className="muted">Tu usuario no tiene un rol habilitado para operar en caja o ventas.</p>
        </section>
      )}
    </main>
  );
}

const CATALOG_PAGE_SIZE = 100;

type VariantPage = { items: Variant[]; pagination?: { page: number; limit: number; total: number } };

function catalogQuery(branchId: string, search: string, page: number) {
  const query = new URLSearchParams({ branchId, limit: String(CATALOG_PAGE_SIZE), page: String(page) });
  if (search.trim()) query.set("search", search.trim());
  return query.toString();
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
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");
  // Block 1: the wholesale code lives only in this input until submitted;
  // it is cleared on submit, success or failure, and never stored.
  const [wholesaleOpen, setWholesaleOpen] = useState(false);
  const [wholesaleCode, setWholesaleCode] = useState("");

  // GET /variants answers at most CATALOG_PAGE_SIZE items per request, so the
  // catalog is walked page by page. `catalogEpoch` identifies the current
  // branch+search list: an answer that belongs to an older epoch is dropped.
  const catalogEpoch = useRef(0);
  const catalogAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!token || !branchId) return;

    const epoch = ++catalogEpoch.current;
    const controller = new AbortController();
    catalogAbort.current?.abort();
    catalogAbort.current = controller;

    setVariants([]);
    setCatalogPage(1);
    setCatalogTotal(0);
    setCatalogLoading(true);
    setCatalogLoadingMore(false);
    setError("");

    apiRequest<VariantPage>(`/variants?${catalogQuery(branchId, search, 1)}`, token, {
      signal: controller.signal,
    })
      .then(({ items, pagination }) => {
        if (catalogEpoch.current !== epoch) return;
        setVariants(items);
        setCatalogTotal(pagination?.total ?? items.length);
      })
      .catch((cause: Error) => {
        if (cause.name !== "AbortError" && catalogEpoch.current === epoch) setError(cause.message);
      })
      .finally(() => {
        if (catalogEpoch.current === epoch) setCatalogLoading(false);
      });

    return () => controller.abort();
  }, [token, branchId, search]);

  const catalogHasMore = variants.length > 0 && catalogPage * CATALOG_PAGE_SIZE < catalogTotal;

  function loadMoreCatalog() {
    if (!token || !branchId || catalogLoading || catalogLoadingMore || !catalogHasMore) return;

    const epoch = catalogEpoch.current;
    const nextPage = catalogPage + 1;
    const controller = new AbortController();
    catalogAbort.current = controller;

    setCatalogLoadingMore(true);
    setError("");

    apiRequest<VariantPage>(`/variants?${catalogQuery(branchId, search, nextPage)}`, token, {
      signal: controller.signal,
    })
      .then(({ items, pagination }) => {
        if (catalogEpoch.current !== epoch) return;
        setVariants((current) => {
          const known = new Set(current.map((variant) => variant.id));
          return [...current, ...items.filter((variant) => !known.has(variant.id))];
        });
        setCatalogPage(nextPage);
        setCatalogTotal(pagination?.total ?? 0);
      })
      .catch((cause: Error) => {
        if (cause.name !== "AbortError" && catalogEpoch.current === epoch) setError(cause.message);
      })
      .finally(() => {
        if (catalogEpoch.current === epoch) setCatalogLoadingMore(false);
      });
  }

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
      closeWholesale();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir la venta.");
    } finally {
      setActionLoading(false);
    }
  }

  async function addVariant(variant: Variant) {
    // A variant without a CASH base is not sellable (the server answers CASH_PRICE_MISSING): never offer it.
    if (!catalogCashPrice(variant).configured) return;
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

  function closeWholesale() {
    setWholesaleOpen(false);
    setWholesaleCode("");
  }

  async function activateWholesale() {
    const code = wholesaleCode;
    setWholesaleCode("");
    if (!token || !sale || !code.trim()) return;
    setActionLoading(true);
    setError("");

    try {
      const nextSale = await apiRequest<Sale>(`/sales/${sale.id}/wholesale`, token, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setSale(nextSale);
      closeWholesale();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo activar la venta mayorista.");
    } finally {
      setActionLoading(false);
    }
  }

  async function updatePriceMode(priceMode: PriceMode) {
    if (!token || !sale || sale.priceMode === priceMode) return;
    setActionLoading(true);
    setError("");

    try {
      const nextSale = await apiRequest<Sale>(`/sales/${sale.id}/price-mode`, token, {
        method: "PATCH",
        body: JSON.stringify({ priceMode }),
      });
      setSale(nextSale);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cambiar el modo de precio.");
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
    closeWholesale();
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
            labels={user.branches}
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
          <span>{`${variants.length} de ${Math.max(catalogTotal, variants.length)} variantes visibles para esta sucursal`}</span>
        </div>

        {error ? <p className="error-banner" role="alert">{error}</p> : null}

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
              {demoReady ? <span className="demo-pill">Demo ARS 165.000</span> : null}
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
                  const price = catalogCashPrice(variant);
                  const canAdd = price.configured && stock > inCart;

                  return (
                    <article className="product-card" key={variant.id}>
                      <div className="product-art">{variant.product.name.slice(0, 2).toUpperCase()}</div>
                      <div className="product-info">
                        <h3>{variant.product.name}</h3>
                        <p>{variantLabel(variant)}</p>
                        <small>{variant.sku}</small>
                      </div>
                      <div className="product-bottom">
                        {price.configured ? (
                          <strong title="Precio efectivo (base). El importe de la venta lo define el servidor según el modo de precio.">
                            {formatMoney(price.cents)}
                          </strong>
                        ) : (
                          <strong className="price-missing">Sin precio configurado</strong>
                        )}
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
                        {price.configured ? "Agregar" : "No disponible"}
                      </button>
                    </article>
                  );
                })
              )}
            </div>
            {catalogHasMore ? (
              <div className="catalog-more">
                <button
                  className="secondary-button"
                  onClick={loadMoreCatalog}
                  disabled={catalogLoadingMore}
                >
                  {catalogLoadingMore ? "Cargando..." : "Cargar más"}
                </button>
              </div>
            ) : null}
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
            {sale.pricingMode === "WHOLESALE" ? (
              <p className="state-pill">Venta mayorista activa</p>
            ) : wholesaleOpen ? (
              <form
                className="correction-panel"
                onSubmit={(event) => {
                  event.preventDefault();
                  activateWholesale();
                }}
              >
                <label>
                  Código mayorista
                  <input
                    type="password"
                    autoComplete="off"
                    value={wholesaleCode}
                    onChange={(event) => setWholesaleCode(event.target.value)}
                    disabled={actionLoading}
                  />
                </label>
                <button type="submit" className="secondary-button" disabled={actionLoading || !wholesaleCode.trim()}>
                  Activar mayorista
                </button>
                <button type="button" className="secondary-button" onClick={closeWholesale} disabled={actionLoading}>
                  Cancelar
                </button>
              </form>
            ) : (
              <button className="secondary-button" onClick={() => setWholesaleOpen(true)} disabled={actionLoading}>
                Mayorista
              </button>
            )}
            <label className="search-box">
              Modo de precio
              <select
                value={sale.priceMode ?? "CASH"}
                disabled={actionLoading}
                onChange={(event) => updatePriceMode(event.target.value as PriceMode)}
              >
                <option value="CASH">Efectivo</option>
                <option value="LIST">Lista</option>
                <option value="CREDIT_CARD">Tarjeta crédito</option>
                <option value="DEBIT_CARD">Tarjeta débito</option>
                <option value="BANK_TRANSFER">Transferencia</option>
                <option value="QR">QR</option>
              </select>
            </label>
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

// M2: every register session whose close is in flight. Module level, so it
// survives the cashier workspace being unmounted and mounted again (switching
// to "Venta" and back) while a close is pending. A second close of any of them
// is refused until its own answer arrives; other sessions are never blocked.
const CLOSES_IN_FLIGHT = new Set<string>();

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
  // `cashSession === null` solo significa «cerrada» una vez que la caja de la
  // sucursal elegida se leyó: antes de eso (carga inicial, cambio de sucursal,
  // lectura fallida) la caja es desconocida, no cerrada.
  const [cashKnown, setCashKnown] = useState(false);
  // CASH-1: the reconciliation of the last close (only for sessions closed
  // WITH reconciliation — never for pre-CASH-1 history) and the recent close
  // history of the authorized branch.
  const [closeResult, setCloseResult] = useState<CashSession | null>(null);
  const [cashHistory, setCashHistory] = useState<CashSession[]>([]);
  const [cashHistoryFailed, setCashHistoryFailed] = useState(false);
  // CASH-1.1: the history route requires cash.session.close (re-checked by
  // the server at the register's own location), so it is only requested when
  // the projected permission is present.
  const canViewCashHistory = user.permissions.includes("cash.session.close");
  // CLIENT-CASH-UX: the panel and its Gasto/Historial apply only at the ACTIVE
  // branch the server's branch-aware hint covers — never the old global
  // permission test, which wrongly showed the panel for a branch the grant
  // does not reach (and hid real BranchSelect state behind a global flag).
  const canManageCashMovements = user.cashMovementLocationIds.includes(branchId);
  // Retiro/Corregir are supervisor-only acts; the server 403s anything else,
  // so the UI must not offer them where the user is not the supervisor.
  const canSuperviseCashMovements = user.cashSupervisorLocationIds.includes(branchId);
  const [cashMovements, setCashMovements] = useState<CashMovement[]>([]);
  const [cashMovementsFailed, setCashMovementsFailed] = useState(false);
  const [cashMovementKind, setCashMovementKind] = useState<CashMovementKind>("EXPENSE");
  const [cashMovementAmount, setCashMovementAmount] = useState("");
  const [cashMovementReason, setCashMovementReason] = useState("");
  const [cashMovementIntent, setCashMovementIntent] = useState<CashMovementIntent | null>(null);
  const [cashMovementRetry, setCashMovementRetry] = useState(false);
  const [cashMovementLoading, setCashMovementLoading] = useState(false);
  const [cashReversalTarget, setCashReversalTarget] = useState<CashMovement | null>(null);
  const [cashReversalReason, setCashReversalReason] = useState("");
  const [cashReversalIntent, setCashReversalIntent] = useState<CashReversalIntent | null>(null);
  const [pendingSales, setPendingSales] = useState<PendingSale[]>([]);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  // R3-A4.2b: registro de intentos del cobro proporcional, por venta. Vive acá
  // —y no dentro del panel— porque un intento tiene que sobrevivir al cambio de
  // venta, al refresco de la cola (incluido el sondeo de 15 s) y al
  // montaje/desmontaje del panel. Un intento pendiente, incierto o confirmado
  // NUNCA se descarta solo: la venta puede dejar la cola y su intento sigue.
  //
  // Límite declarado: es memoria del proceso. Una recarga completa de la página
  // lo pierde, y con él la única prueba local de la clave ya enviada. No se
  // persiste en localStorage/sessionStorage (ver los riesgos en el informe de
  // R3-A4.2b): una copia en el navegador quedaría fuera del ciclo de vida de la
  // sesión y del token, y sobreviviría al cierre de sesión.
  const [checkoutAttempts, setCheckoutAttempts] = useState<Record<string, ProductionCheckoutAttempt>>({});
  const checkoutInFlight = useRef<Set<string>>(new Set());
  const codedRequest = useCallback(
    (path: string, options: RequestInit) => apiRequestCoded(path, token, options),
    [token],
  );
  const recordAttempt = useCallback((next: ProductionCheckoutAttempt) => {
    setCheckoutAttempts((current) => ({ ...current, [next.saleId]: next }));
  }, []);
  const discardAttempt = useCallback((saleId: string) => {
    setCheckoutAttempts((current) => {
      const rest = { ...current };
      delete rest[saleId];
      return rest;
    });
  }, []);
  // M1: payment lists are kept per sale (the last validated list of each), so
  // another sale's payments (or "no payments") are never shown under the
  // selected one, and returning to a sale keeps its last validated list.
  const [paymentsBySale, setPaymentsBySale] = useState<
    Record<string, { items: SalePayment[]; status: "ready" | "failed" | "invalid" }>
  >({});
  // M1: the last /sales/pending answer was invalid, so no row is shown (and
  // the queue is never presented as empty) until a valid answer arrives.
  const [queueInvalid, setQueueInvalid] = useState(false);
  // M2: the close the cashier asked for, waiting for the explicit second step.
  // Bound to the session and branch it was asked for; any change voids it.
  const [closeConfirm, setCloseConfirm] = useState<{
    sessionId: string;
    branchId: string;
    registerName: string;
    openedAt: string;
    closingCash: string;
  } | null>(null);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [startingCash, setStartingCash] = useState("0");
  const [closingCash, setClosingCash] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [retryIntent, setRetryIntent] = useState<PaymentIntent | null>(null);
  const [splitPayment, setSplitPayment] = useState(false);
  const [correctionLines, setCorrectionLines] = useState<CorrectionLine[] | null>(null);
  const [cancelReason, setCancelReason] = useState<CancellationReason | "" | null>(null);
  const [cancelNote, setCancelNote] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
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
      priceMode: completedSale.priceMode,
      // El snapshot completado sólo lo produce el flujo FIXED_TOTAL (POST
      // /complete): una venta proporcional se cobra por su propio circuito y
      // nunca llega acá.
      pricingModel: "FIXED_TOTAL",
      checkoutRequired: false,
    };
  }, [completedSale, selectedSaleId]);
  const displaySale = selectedSale ?? completedSnapshot;
  const selectedPaymentsEntry = selectedSaleId ? paymentsBySale[selectedSaleId] : undefined;
  const selectedPayments = selectedPaymentsEntry?.items ?? [];
  const paymentsStatus = selectedPaymentsEntry?.status ?? "loading";
  const fixedPriceMode = displaySale?.priceMode;
  const requiredMethod = fixedPriceMode ? PRICE_MODE_METHOD[fixedPriceMode] : undefined;
  // System V2 P0-A: the traditional (FIXED_TOTAL) payment takes CASH only. Every
  // non-cash method is charged through the proportional checkout, so the method
  // of this panel always starts as cash for the selected sale.
  useEffect(() => {
    setPaymentMethod("CASH");
  }, [selectedSaleId]);
  const nonCashPriceMode = requiredMethod !== undefined && requiredMethod !== "CASH";

  // Pilot P0.2-C: paid and remaining amounts are the server's queue values,
  // read-only. The client never recomputes them from its payment list.
  const saleTotal = displaySale ? cents(displaySale.total) : ZERO;
  const effectivePaidAmount = completedSnapshot ? saleTotal : displaySale ? cents(displaySale.paidAmount) : ZERO;
  const remaining = completedSnapshot ? ZERO : displaySale ? cents(displaySale.remainingBalance) : ZERO;
  const isPaid = Boolean(displaySale && saleTotal > ZERO && remaining === ZERO);
  // R3-A4.2b: el circuito lo decide el `checkoutRequired` que el servidor
  // persistió, nunca una inferencia local. La coherencia con `pricingModel` ya
  // la exigió el parser de la cola, así que acá alcanza con leerlo.
  const proportionalCircuit = displaySale?.checkoutRequired === true;
  const paymentBlocked = selectedSale?.canAcceptPayment === false;
  const selectedStatus = completedSale?.id === selectedSaleId ? "COMPLETED" : isPaid ? "PAID" : "PENDING_PAYMENT";
  const cashReceivedCents = arsToCents(cashReceived);
  // Split OFF: the payment is exactly the server's remaining balance.
  const paymentAmountCents = splitPayment ? arsToCents(paymentAmount) : remaining.toString();
  const hasPayments = (selectedSale?.paymentCount ?? 0) > 0;
  const correctionValid = Boolean(
    correctionLines && correctionLines.length > 0 && correctionLines.every((line) => /^[1-9][0-9]*$/.test(line.quantity)),
  );
  const changeAmount =
    paymentMethod === "CASH" && cashReceivedCents && paymentAmountCents
      ? cents(cashReceivedCents) - cents(paymentAmountCents)
      : ZERO;

  // M1: only the latest read of the sale that is still selected may write the
  // payment list; a late answer for a previously selected sale is dropped.
  const selectedSaleRef = useRef<string | null>(null);
  useEffect(() => {
    selectedSaleRef.current = selectedSaleId;
  }, [selectedSaleId]);
  const paymentsRequest = useRef({ next: 0, latest: new Map<string, number>() });
  const loadPayments = useCallback(
    async (saleId: string) => {
      if (!token) return;
      const request = ++paymentsRequest.current.next;
      paymentsRequest.current.latest.set(saleId, request);
      const isLatest = () => paymentsRequest.current.latest.get(saleId) === request && selectedSaleRef.current === saleId;
      try {
        const items = parseSalePayments(await apiRequest<unknown>(`/sales/${saleId}/payments`, token), saleId);
        if (!isLatest()) return;
        setPaymentsBySale((current) => ({ ...current, [saleId]: { items, status: "ready" } }));
      } catch (cause) {
        if (!isLatest()) return;
        if (cause instanceof InvalidResponseError) {
          setPaymentsBySale((current) => ({ ...current, [saleId]: { items: [], status: "invalid" } }));
        } else {
          // A network/HTTP failure keeps this sale's last valid list; a sale
          // that never loaded is shown as failed, never as "no payments".
          setPaymentsBySale((current) =>
            current[saleId]?.status === "ready" ? current : { ...current, [saleId]: { items: [], status: "failed" } },
          );
        }
        throw cause;
      }
    },
    [token],
  );

  // M1: the queue is read by the manual refresh, the poll and the follow-up
  // of every cashier action; only the latest read may write it (valid or
  // invalid). An older answer, or its failure, is dropped (returns null).
  const queueRequest = useRef(0);
  const refreshQueue = useCallback(async (): Promise<PendingSale[] | null> => {
    if (!token) return [];
    const request = ++queueRequest.current;
    let items: PendingSale[];
    try {
      items = parsePendingSales(await apiRequest<unknown>("/sales/pending", token));
    } catch (cause) {
      if (request !== queueRequest.current) return null;
      if (cause instanceof InvalidResponseError) {
        setPendingSales([]);
        setQueueInvalid(true);
      }
      throw cause;
    }
    if (request !== queueRequest.current) return null;
    setQueueInvalid(false);
    setPendingSales(items);
    setSelectedSaleId((current) => {
      if (current && items.some((sale) => sale.saleId === current)) return current;
      return items[0]?.saleId ?? current;
    });
    return items;
  }, [token]);

  // Payment-entry state derived from an authoritative remaining balance.
  // Used when the selected sale changes AND after a committed same-sale
  // correction (Codex P0.2): the sale id stays the same there, so a stale
  // tender (e.g. CASH received) must never survive the new balance.
  const resetPaymentEntry = useCallback((balance: string) => {
    setPaymentAmount(centsToArsInput(balance));
    setCashReceived(centsToArsInput(balance));
    setRetryIntent(null);
    setSplitPayment(false);
  }, []);

  // CASH-1.1: the close history never rejects and is never awaited by the
  // operational refresh. A 403/500 or a malformed payload only empties the
  // list, and a slow answer can never keep the register controls disabled.
  // Only the latest request may write: a late answer for a previously
  // selected branch is dropped (location-bound presentation).
  const cashHistoryRequest = useRef(0);
  const cashMovementsRequest = useRef(0);
  // CASH-1.1: bumped on every branch change, so an answer that belongs to the
  // previously selected branch (e.g. a slow close) never writes into this one.
  const branchEpoch = useRef(0);
  const refreshCashHistory = useCallback(async () => {
    const request = ++cashHistoryRequest.current;
    if (!token || !branchId || !canViewCashHistory) {
      setCashHistory([]);
      setCashHistoryFailed(false);
      return;
    }
    const query = new URLSearchParams({ branchId });
    try {
      const history = await apiRequest<unknown>(`/cash/sessions?${query.toString()}`, token);
      if (request !== cashHistoryRequest.current) return;
      setCashHistory(Array.isArray(history) ? history.filter(isCashSessionEntry) : []);
      setCashHistoryFailed(false);
    } catch {
      if (request !== cashHistoryRequest.current) return;
      setCashHistory([]);
      setCashHistoryFailed(true);
    }
  }, [token, branchId, canViewCashHistory]);

  const refreshCashMovements = useCallback(async (sessionId: string) => {
    const request = ++cashMovementsRequest.current;
    if (!token || !canManageCashMovements) {
      setCashMovements([]);
      setCashMovementsFailed(false);
      return;
    }
    try {
      const movements = parseCashMovements(
        await apiRequest<unknown>(`/cash/sessions/${sessionId}/movements`, token),
        sessionId,
      );
      if (request !== cashMovementsRequest.current) return;
      setCashMovements(movements);
      setCashMovementsFailed(false);
    } catch (cause) {
      if (request !== cashMovementsRequest.current) return;
      setCashMovements([]);
      setCashMovementsFailed(true);
      throw cause;
    }
  }, [token, canManageCashMovements]);

  // The register and the open session are location-bound too: only the latest
  // read may write them, and never after a branch change. Bumped by every
  // newer read, by a committed open and by a branch change, so a late answer
  // (or failure) of an older read is dropped instead of overwriting newer state.
  const cashStateRequest = useRef(0);
  const refreshCash = useCallback(async () => {
    if (!token || !branchId) return;
    const request = ++cashStateRequest.current;
    const epoch = branchEpoch.current;
    const isLatest = () => request === cashStateRequest.current && epoch === branchEpoch.current;
    const query = new URLSearchParams({ branchId });
    void refreshCashHistory();
    try {
      const currentRegister = await apiRequest<CashRegister>(`/cash/register?${query.toString()}`, token);
      const currentSession = await apiRequest<CashSession | null>(`/cash/current?${query.toString()}`, token);
      if (!isLatest()) return;
      setRegister(currentRegister);
      setCashSession(currentSession);
      setCashKnown(true);
    } catch (cause) {
      if (!isLatest()) return;
      throw cause;
    }
  }, [token, branchId, refreshCashHistory]);

  // Only the latest refresh owns the loading flag and the error banner: a
  // previous branch's refresh finishing late never re-enables the controls
  // while the selected branch still loads, nor reports its failure there.
  const refreshAllRequest = useRef(0);
  const refreshAll = useCallback(async () => {
    const request = ++refreshAllRequest.current;
    const epoch = branchEpoch.current;
    setLoading(true);
    setError("");
    try {
      await Promise.all([refreshCash(), refreshQueue()]);
    } catch (cause) {
      if (request !== refreshAllRequest.current || epoch !== branchEpoch.current) return;
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar caja.");
    } finally {
      if (request === refreshAllRequest.current && epoch === branchEpoch.current) setLoading(false);
    }
  }, [refreshCash, refreshQueue]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!cashSession || !canManageCashMovements) {
      cashMovementsRequest.current += 1;
      setCashMovements([]);
      setCashMovementsFailed(false);
      return;
    }
    refreshCashMovements(cashSession.sessionId).catch(() => undefined);
  }, [cashSession, canManageCashMovements, refreshCashMovements]);

  useEffect(() => {
    if (!selectedSaleId) return;
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
    resetPaymentEntry(defaultAmount);
    setCompletedSale(null);
    setCorrectionLines(null);
    setCancelReason(null);
    setCancelNote("");
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
    const epoch = branchEpoch.current;
    try {
      const session = await apiRequest<CashSession>("/cash/sessions/open", token, {
        method: "POST",
        body: JSON.stringify({ registerId: register.id, startingCash: amount }),
      });
      // Opened for the previous branch: never show it as the selected one's.
      if (epoch !== branchEpoch.current) return;
      // A read started before this open must not replace the new session.
      cashStateRequest.current += 1;
      setCashSession(session);
      setCashKnown(true);
      setCloseResult(null);
      setNotice("Sesión de caja abierta.");
    } catch (cause) {
      if (epoch !== branchEpoch.current) return;
      setError(cause instanceof Error ? cause.message : "No se pudo abrir caja.");
    } finally {
      // After a branch change the new branch's refresh owns the loading flag.
      if (epoch === branchEpoch.current) setLoading(false);
    }
  }

  // M2: a confirmation is void as soon as the session or the branch it was
  // asked for is no longer the one shown (another session, a close done
  // elsewhere, a branch change). A refresh of the same session keeps it.
  useEffect(() => {
    setCloseConfirm((current) =>
      current && (current.sessionId !== cashSession?.sessionId || current.branchId !== branchId) ? null : current,
    );
  }, [cashSession, branchId]);

  // M2, first step: validates the amount and asks for confirmation. It never
  // calls the close endpoint.
  function requestCloseCashSession() {
    if (!cashSession) return;
    const amount = arsToCents(closingCash);
    if (!amount) {
      setError("Ingresá un monto de cierre válido.");
      return;
    }
    setError("");
    setNotice("");
    setCloseConfirm({
      sessionId: cashSession.sessionId,
      branchId,
      registerName: register?.name ?? "Caja de la sucursal",
      openedAt: cashSession.openedAt,
      closingCash: amount,
    });
  }

  // M2, second step: closes exactly the confirmed session with the confirmed
  // amount, once. The CASH-1 handling of the answer is unchanged.
  async function closeCashSession() {
    const confirm = closeConfirm;
    if (!token || !confirm) return;
    if (CLOSES_IN_FLIGHT.has(confirm.sessionId)) {
      setCloseConfirm(null);
      setError("El cierre de esta caja ya está en curso.");
      return;
    }
    if (!cashSession || confirm.sessionId !== cashSession.sessionId || confirm.branchId !== branchId) {
      setCloseConfirm(null);
      setError("La caja cambió: revisá el cierre y confirmalo de nuevo.");
      return;
    }
    const amount = confirm.closingCash;

    CLOSES_IN_FLIGHT.add(confirm.sessionId);
    setLoading(true);
    setError("");
    const epoch = branchEpoch.current;
    try {
      const closed = await apiRequest<unknown>(`/cash/sessions/${confirm.sessionId}/close`, token, {
        method: "POST",
        body: JSON.stringify({ closingCash: amount }),
      });
      // The branch changed while closing: this answer belongs to the previous
      // branch and must not touch the selected branch's register or results.
      if (epoch !== branchEpoch.current) return;
      setCashSession(null);
      setCashKnown(true);
      if (isCashSessionEntry(closed)) {
        setCloseResult(closed);
        setNotice(
          closed.expectedCash != null && closed.difference != null
            ? `Caja cerrada con ${formatMoney(closed.closingCash ?? amount)}. Diferencia ${formatSignedMoney(closed.difference)}.`
            : `Caja cerrada con ${formatMoney(closed.closingCash ?? amount)}.`,
        );
      } else {
        // Closed by the server, but the answer is malformed: no amounts.
        setCloseResult(null);
        setNotice("Caja cerrada.");
      }
      refreshCash().catch(() => undefined);
    } catch (cause) {
      if (epoch !== branchEpoch.current) return;
      setError(cause instanceof Error ? cause.message : "No se pudo cerrar caja.");
    } finally {
      CLOSES_IN_FLIGHT.delete(confirm.sessionId);
      // Only this close's own confirmation is consumed (closed or failed).
      setCloseConfirm((current) => (current === confirm ? null : current));
      if (epoch === branchEpoch.current) setLoading(false);
    }
  }

  function requestCashMovement() {
    if (!cashSession) return;
    // CLIENT-CASH-UX: only the supervisor of THIS branch may ever enter the
    // withdrawal circuit; the review step must not mint an intent that can
    // only end in the server's 403.
    if (cashMovementKind === "WITHDRAWAL" && !canSuperviseCashMovements) return;
    const amount = arsToCents(cashMovementAmount);
    const reason = cashMovementReason.trim();
    if (!amount || cents(amount) <= ZERO) {
      setError("Ingresá un importe de movimiento válido.");
      return;
    }
    if (!reason) {
      setError("Ingresá el motivo del movimiento.");
      return;
    }
    setError("");
    setNotice("");
    setCashMovementRetry(false);
    setCashMovementIntent({
      sessionId: cashSession.sessionId,
      kind: cashMovementKind,
      amount,
      reason,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  async function submitCashMovement() {
    const intent = cashMovementIntent;
    if (!token || !intent) return;
    if (!cashSession || cashSession.sessionId !== intent.sessionId) {
      setCashMovementIntent(null);
      setCashMovementRetry(false);
      setError("La caja cambió: revisá el movimiento y confirmalo de nuevo.");
      return;
    }

    setCashMovementLoading(true);
    setError("");
    setNotice("");
    const epoch = branchEpoch.current;
    try {
      const endpoint = intent.kind === "WITHDRAWAL" ? "withdrawals" : "expenses";
      await apiRequest(`/cash/sessions/${intent.sessionId}/${endpoint}`, token, {
        method: "POST",
        body: JSON.stringify({
          amount: intent.amount,
          reason: intent.reason,
          idempotencyKey: intent.idempotencyKey,
        }),
      });
      if (epoch !== branchEpoch.current) return;
      setCashMovementIntent(null);
      setCashMovementRetry(false);
      setCashMovementAmount("");
      setCashMovementReason("");
      setNotice(intent.kind === "WITHDRAWAL" ? "Retiro registrado." : "Gasto registrado.");
      try {
        await refreshCashMovements(intent.sessionId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "No se pudieron actualizar los movimientos de caja.");
      }
    } catch (cause) {
      if (epoch !== branchEpoch.current) return;
      // The same confirmed intent keeps its UUID. This makes an ambiguous
      // transport failure safe to retry without creating a second exit.
      setCashMovementRetry(true);
      setError(cause instanceof Error ? cause.message : "No se pudo registrar el movimiento de caja.");
    } finally {
      if (epoch === branchEpoch.current) setCashMovementLoading(false);
    }
  }

  function startCashReversal(movement: CashMovement) {
    setError("");
    setNotice("");
    setCashReversalTarget(movement);
    setCashReversalReason("");
    setCashReversalIntent(null);
  }

  function cancelCashReversal() {
    setCashReversalTarget(null);
    setCashReversalReason("");
    setCashReversalIntent(null);
  }

  async function submitCashReversal() {
    const target = cashReversalTarget;
    if (!token || !target) return;
    if (!cashSession || cashSession.sessionId !== target.sessionId) {
      cancelCashReversal();
      setError("La caja cambió: revisá el movimiento y corregilo de nuevo.");
      return;
    }
    // A pending (failed) intent is retried exactly as confirmed; otherwise this
    // is a NEW intent and gets a NEW key.
    let intent = cashReversalIntent;
    if (!intent) {
      const reason = cashReversalReason.trim();
      if (!reason) {
        setError("Ingresá el motivo de la corrección.");
        return;
      }
      intent = { sessionId: target.sessionId, movementId: target.id, reason, idempotencyKey: crypto.randomUUID() };
    }

    setCashMovementLoading(true);
    setError("");
    setNotice("");
    const epoch = branchEpoch.current;
    try {
      // The amount and type are the server's: only the reason and key are sent.
      await apiRequest(`/cash/sessions/${intent.sessionId}/movements/${intent.movementId}/reversal`, token, {
        method: "POST",
        body: JSON.stringify({ reason: intent.reason, idempotencyKey: intent.idempotencyKey }),
      });
      if (epoch !== branchEpoch.current) return;
      cancelCashReversal();
      setNotice("Corrección registrada.");
      try {
        await refreshCashMovements(intent.sessionId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "No se pudieron actualizar los movimientos de caja.");
      }
    } catch (cause) {
      if (epoch !== branchEpoch.current) return;
      // The confirmed intent keeps its UUID: an ambiguous transport failure is
      // safe to retry without a second correction.
      setCashReversalIntent(intent);
      setError(cause instanceof Error ? cause.message : "No se pudo registrar la corrección.");
    } finally {
      if (epoch === branchEpoch.current) setCashMovementLoading(false);
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
    } catch (cause) {
      // M1: the retry belongs to the sale that started the payment; it is
      // never offered under another sale selected meanwhile.
      const sameSale = selectedSaleRef.current === intent.saleId;
      if (sameSale) setRetryIntent(intent);
      const message = cause instanceof Error ? cause.message : "No se pudo registrar el pago.";
      setError(sameSale ? message : `Venta ${intent.saleRef}: ${message}`);
      setPaymentLoading(false);
      return;
    }
    // M1: the payment is committed. A failed or invalid refresh afterwards is
    // reported as such, never as a failed payment offered for retry.
    setRetryIntent(null);
    setNotice(
      selectedSaleRef.current === intent.saleId
        ? `${intent.label} registrado.`
        : `${intent.label} registrado en la venta ${intent.saleRef}.`,
    );
    // Both reads are attempted: a failed payment list never leaves the queue
    // (and its remaining balance) stale.
    const refreshes = await Promise.allSettled([loadPayments(intent.saleId), refreshQueue()]);
    const failed = refreshes.find((result) => result.status === "rejected");
    if (failed) {
      setError(failed.reason instanceof Error ? failed.reason.message : "No se pudo actualizar la venta.");
    }
    setPaymentLoading(false);
  }

  async function registerPayment() {
    if (!selectedSale) return;
    const amount = paymentAmountCents;
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
      saleRef: selectedSale.saleNumber ?? shortId(selectedSale.saleId),
    };

    await submitPayment(intent);
  }

  function startCorrection() {
    if (!selectedSale) return;
    const lines = new Map<string, CorrectionLine>();
    for (const item of selectedSale.items) {
      const current = lines.get(item.variantId);
      lines.set(item.variantId, {
        variantId: item.variantId, productName: item.productName, variantName: item.variantName,
        quantity: current ? (cents(current.quantity) + cents(item.quantity)).toString() : item.quantity,
      });
    }
    setCorrectionLines([...lines.values()]);
    setCancelReason(null);
    setError("");
    setNotice("");
  }

  // Pilot P0.2-A/C: the complete target list goes to the server; nothing is
  // shown as corrected until it commits and the queue is refetched.
  async function submitCorrection() {
    if (!token || !selectedSale || !correctionLines || !correctionValid) return;
    setActionLoading(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(`/sales/${selectedSale.saleId}/correct`, token, {
        method: "POST",
        body: JSON.stringify({ items: correctionLines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })) }),
      });
      setCorrectionLines(null);
      const refreshed = (await refreshQueue())?.find((sale) => sale.saleId === selectedSale.saleId);
      if (refreshed) resetPaymentEntry(refreshed.remainingBalance);
      setNotice("Venta corregida.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo corregir la venta.");
    } finally {
      setActionLoading(false);
    }
  }

  // Block 1: the server records the confirmation (own location, never the
  // sale's seller); the queue is refetched for the authoritative state.
  async function confirmWholesale() {
    if (!token || !selectedSale) return;
    setActionLoading(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(`/sales/${selectedSale.saleId}/wholesale/confirm`, token, { method: "POST" });
      await refreshQueue();
      setNotice("Venta mayorista confirmada.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar la venta mayorista.");
    } finally {
      setActionLoading(false);
    }
  }

  async function submitCancellation() {
    if (!token || !selectedSale || !cancelReason) return;
    const note = cancelNote.trim();
    if (cancelReason === "OTHER" && !note) return;
    setActionLoading(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(`/sales/${selectedSale.saleId}/cancel`, token, {
        method: "POST",
        body: JSON.stringify({ reason: cancelReason, ...(note ? { note } : {}) }),
      });
      setCancelReason(null);
      setCancelNote("");
      setPaymentsBySale((current) => ({ ...current, [selectedSale.saleId]: { items: [], status: "ready" } }));
      await refreshQueue();
      setNotice("Venta cancelada.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cancelar la venta.");
    } finally {
      setActionLoading(false);
    }
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
      setPaymentsBySale((current) => ({ ...current, [selectedSale.saleId]: { items: [], status: "ready" } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la venta.");
    } finally {
      setCompleteLoading(false);
    }
  }

  function changeBranch(nextBranchId: string) {
    onBranchChange(nextBranchId);
    // CASH-1.1: history and close results are branch-bound; never show the
    // previous branch's closes while the new branch loads, and drop late
    // answers that belong to the previous branch.
    branchEpoch.current += 1;
    cashHistoryRequest.current += 1;
    cashMovementsRequest.current += 1;
    cashStateRequest.current += 1;
    refreshAllRequest.current += 1;
    // The previous branch's register and session are never shown (nor
    // closable) under the new branch while its own state loads.
    setRegister(null);
    setCashSession(null);
    setCashKnown(false);
    setCashHistory([]);
    setCashHistoryFailed(false);
    setCashMovements([]);
    setCashMovementsFailed(false);
    setCashMovementIntent(null);
    setCashMovementRetry(false);
    setCashMovementAmount("");
    setCashMovementReason("");
    // CLIENT-CASH-UX (R-2/R-3, branch-aware): the WITHDRAWAL kind itself is
    // branch-bound supervision state. A non-supervisor branch must never
    // inherit a Retiro kind selected under another branch's supervisor scope
    // (which would re-create the show-then-403 pattern through the kind
    // label and the withdrawal endpoint).
    setCashMovementKind("EXPENSE");
    // R-2: a correction belongs to the previous branch's session. The open
    // dialog, its reason and its confirmed intent are discarded (never sent or
    // re-keyed here); an in-flight request's late answer is already dropped by
    // the epoch, so its pending flag is released for the new branch.
    setCashReversalTarget(null);
    setCashReversalReason("");
    setCashReversalIntent(null);
    setCashMovementLoading(false);
    setCloseResult(null);
    setSelectedSaleId(null);
    setPaymentsBySale({});
    setCloseConfirm(null);
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
            labels={user.branches}
            // R-3: like a payment, an in-flight exit or correction pins the
            // branch, so its intent can never be discarded and re-keyed.
            disabled={loading || paymentLoading || completeLoading || cashMovementLoading}
            onChange={changeBranch}
          />
        </div>

        <CashSessionPanel
          register={register}
          session={cashSession}
          known={cashKnown}
          startingCash={startingCash}
          closingCash={closingCash}
          loading={loading}
          onStartingCashChange={setStartingCash}
          onClosingCashChange={setClosingCash}
          onOpen={openCashSession}
          onClose={requestCloseCashSession}
          confirm={closeConfirm}
          onConfirmClose={closeCashSession}
          onCancelClose={() => setCloseConfirm(null)}
        />

        {cashSession && canManageCashMovements ? (
          <CashMovementPanel
            canSupervise={canSuperviseCashMovements}
            session={cashSession}
            movements={cashMovements}
            movementsFailed={cashMovementsFailed}
            kind={cashMovementKind}
            amount={cashMovementAmount}
            reason={cashMovementReason}
            loading={cashMovementLoading}
            intent={cashMovementIntent}
            retry={cashMovementRetry}
            onKindChange={setCashMovementKind}
            onAmountChange={setCashMovementAmount}
            onReasonChange={setCashMovementReason}
            onReview={requestCashMovement}
            onConfirm={submitCashMovement}
            onCancel={() => {
              setCashMovementIntent(null);
              setCashMovementRetry(false);
            }}
            reversalTarget={cashReversalTarget}
            reversalReason={cashReversalReason}
            reversalPending={cashReversalIntent !== null}
            onStartReversal={startCashReversal}
            onReversalReasonChange={setCashReversalReason}
            onConfirmReversal={submitCashReversal}
            onCancelReversal={cancelCashReversal}
          />
        ) : null}

        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        {notice ? <p className="notice-banner" role="status">{notice}</p> : null}

        {closeResult && closeResult.branchId === branchId && closeResult.expectedCash != null && closeResult.countedCash != null && closeResult.difference != null ? (
          <section className="cash-session">
            <div>
              <p className="eyebrow">Conciliación de cierre</p>
              <h2>Caja cerrada</h2>
              <p>Esperado {formatMoney(closeResult.expectedCash)}</p>
              <p>Contado {formatMoney(closeResult.countedCash)}</p>
              <p>
                Diferencia{" "}
                <strong className={closeResult.difference === "0" ? "paid-pill" : "state-pill"}>
                  {formatSignedMoney(closeResult.difference)}
                </strong>
              </p>
            </div>
          </section>
        ) : null}

        {cashHistory.length > 0 ? (
          <section className="cash-session">
            <div>
              <p className="eyebrow">Cierres recientes</p>
              <div className="readonly-items">
                {cashHistory.map((entry) => (
                  <div className="readonly-item" key={entry.sessionId}>
                    <span>
                      <strong>{entry.closedAt ? formatDateTime(entry.closedAt) : "—"}</strong>
                      {/* CASH-1.1: a close without a stored count never shows a zero count. */}
                      <small>{entry.countedCash != null ? `Contado ${formatMoney(entry.countedCash)}` : "Contado no registrado"}</small>
                    </span>
                    {entry.expectedCash != null && entry.difference != null ? (
                      <span className={entry.difference === "0" ? "paid-pill" : "state-pill"}>
                        Diferencia {formatSignedMoney(entry.difference)}
                      </span>
                    ) : (
                      // CASH-1: a pre-CASH-1 close has no reconciliation data
                      // and is never presented as reconciled.
                      <span className="state-pill">Sin conciliar</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}
        {cashHistoryFailed ? <p className="muted">No se pudo cargar el historial de cierres.</p> : null}

        <div className="queue-list">
          {queueInvalid ? (
            <div className="queue-empty">
              <h2>No se pudo validar la cola de ventas.</h2>
              <p>La respuesta del servidor no es válida. Reintentá con Actualizar.</p>
            </div>
          ) : loading && pendingSales.length === 0 ? (
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
                  {sale.pricingMode === "WHOLESALE" ? <small>Mayorista</small> : null}
                </span>
                <span>
                  <strong>{formatMoney(sale.total)}</strong>
                  {sale.status === "PAID" ? (
                    <>
                      <small className="paid-pill">Pagada</small>
                      <small>Falta finalizar</small>
                    </>
                  ) : (
                    <small>{formatSignedMoney(sale.remainingBalance)} pendiente</small>
                  )}
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

            {selectedSale?.pricingMode === "WHOLESALE" ? (
              <div className="sale-actions">
                <span className="state-pill">Mayorista</span>
                {selectedSale.wholesaleConfirmed ? (
                  <span className="paid-pill">Mayorista confirmada</span>
                ) : (
                  <>
                    <p className="cart-note">Caja debe confirmar la venta mayorista antes de cobrarla.</p>
                    {selectedSale.canConfirmWholesale ? (
                      <button className="secondary-button" onClick={confirmWholesale} disabled={actionLoading || paymentLoading}>
                        Confirmar venta mayorista
                      </button>
                    ) : (
                      <p className="cart-note">No podés confirmar esta venta mayorista: debe hacerlo otro cajero de la sucursal.</p>
                    )}
                  </>
                )}
              </div>
            ) : null}

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
                  {paymentsStatus === "invalid" ? (
                    <p className="muted">No se pudieron validar los pagos.</p>
                  ) : paymentsStatus === "failed" ? (
                    <p className="muted">No se pudieron cargar los pagos.</p>
                  ) : paymentsStatus === "loading" ? (
                    <p className="muted">Cargando pagos...</p>
                  ) : selectedPayments.length === 0 ? (
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

            {selectedSale ? (
              <section className="sale-actions">
                {selectedSale.status === "PENDING_PAYMENT" && hasPayments ? (
                  <p className="cart-note">La venta tiene pagos registrados: no admite corrección ni cancelación.</p>
                ) : null}

                {selectedSale.canCorrect && !correctionLines && cancelReason === null ? (
                  <button className="secondary-button" onClick={startCorrection} disabled={actionLoading || paymentLoading}>
                    Corregir venta
                  </button>
                ) : null}
                {selectedSale.canCancel && !correctionLines && cancelReason === null ? (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setCancelReason("");
                      setCancelNote("");
                      setError("");
                      setNotice("");
                    }}
                    disabled={actionLoading || paymentLoading}
                  >
                    Cancelar venta
                  </button>
                ) : null}

                {correctionLines ? (
                  <div className="correction-panel">
                    <h3>Corregir artículos</h3>
                    {correctionLines.map((line) => (
                      <div className="readonly-item" key={line.variantId}>
                        <span>
                          <strong>{line.productName}</strong>
                          <small>{line.variantName}</small>
                        </span>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          aria-label={`Cantidad ${line.productName}`}
                          value={line.quantity}
                          onChange={(event) =>
                            setCorrectionLines((lines) =>
                              lines?.map((current) =>
                                current.variantId === line.variantId ? { ...current, quantity: event.target.value.trim() } : current,
                              ) ?? null,
                            )
                          }
                          disabled={actionLoading}
                        />
                        <button
                          className="remove-button"
                          onClick={() =>
                            setCorrectionLines((lines) => lines?.filter((current) => current.variantId !== line.variantId) ?? null)
                          }
                          disabled={actionLoading}
                          aria-label={`Quitar ${line.productName}`}
                        >
                          x
                        </button>
                      </div>
                    ))}
                    {correctionLines.length === 0 ? (
                      <p className="cart-note">La venta no puede quedar vacía: cancelá la venta.</p>
                    ) : null}
                    <button className="send-button" onClick={submitCorrection} disabled={actionLoading || !correctionValid}>
                      {actionLoading ? "Guardando..." : "Guardar corrección"}
                    </button>
                    <button className="secondary-button" onClick={() => setCorrectionLines(null)} disabled={actionLoading}>
                      Descartar
                    </button>
                  </div>
                ) : null}

                {cancelReason !== null ? (
                  <div className="cancel-panel">
                    <h3>Cancelar venta</h3>
                    <label>
                      Motivo
                      <select
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value as CancellationReason | "")}
                        disabled={actionLoading}
                      >
                        <option value="">Seleccioná un motivo</option>
                        {CANCELLATION_REASONS.map((reason) => (
                          <option key={reason.value} value={reason.value}>
                            {reason.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Nota
                      <textarea
                        value={cancelNote}
                        maxLength={500}
                        onChange={(event) => setCancelNote(event.target.value)}
                        disabled={actionLoading}
                        placeholder={cancelReason === "OTHER" ? "Obligatoria para «Otro motivo»" : "Opcional"}
                      />
                    </label>
                    <button
                      className="send-button"
                      onClick={submitCancellation}
                      disabled={actionLoading || !cancelReason || (cancelReason === "OTHER" && !cancelNote.trim())}
                    >
                      {actionLoading ? "Cancelando..." : "Confirmar cancelación"}
                    </button>
                    <button className="secondary-button" onClick={() => setCancelReason(null)} disabled={actionLoading}>
                      Volver
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </section>

      <aside className="payment-panel">
        <div className="cart-heading">
          <div>
            <p className="eyebrow">Cobro</p>
            {/* El circuito persistido es la señal: nunca hay dos cobros posibles. */}
            <h2>{proportionalCircuit ? "Cobro" : "Registrar pago"}</h2>
          </div>
        </div>

        {!displaySale ? (
          <div className="cart-empty">
            <span>Cobro</span>
            <p>Sin venta seleccionada</p>
            <small>Seleccioná una venta pendiente para cobrar.</small>
          </div>
        ) : proportionalCircuit ? (
          <ProportionalChargePanel
            key={displaySale.saleId}
            request={codedRequest}
            money={MONEY_TOOLS}
            sale={displaySale}
            cashSession={cashSession}
            branchId={branchId}
            cashKnown={cashKnown}
            chargeBlocked={paymentBlocked}
            attempt={checkoutAttempts[displaySale.saleId] ?? null}
            inFlight={checkoutInFlight}
            onAttempt={recordAttempt}
            onDiscardAttempt={discardAttempt}
          />
        ) : (
          <>
            <div className="payment-summary">
              {fixedPriceMode ? <p className="state-pill">Modo precio: {priceModeLabel(fixedPriceMode)}</p> : null}
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
                <option value="TRANSFER" disabled>Transferencia (solo con checkout proporcional)</option>
                <option value="CARD_DEBIT" disabled>Tarjeta de débito (solo con checkout proporcional)</option>
                <option value="CARD_CREDIT" disabled>Tarjeta de crédito (solo con checkout proporcional)</option>
                <option value="QR" disabled>QR (solo con checkout proporcional)</option>
              </select>
            </label>
            {nonCashPriceMode ? (
              <p className="state-pill" role="status">
                Esta venta tiene un modo de precio no efectivo y el cobro tradicional solo admite efectivo. Los cobros con
                transferencia, tarjeta o QR se registran con el checkout proporcional.
              </p>
            ) : null}

            <label className="split-toggle">
              <input
                type="checkbox"
                checked={splitPayment}
                onChange={(event) => {
                  setSplitPayment(event.target.checked);
                  setPaymentAmount(centsToArsInput(remaining.toString()));
                }}
                disabled={paymentLoading || isPaid}
              />
              Pago parcial (dividir el cobro)
            </label>

            <label>
              Importe ARS
              <input
                inputMode="decimal"
                value={splitPayment ? paymentAmount : centsToArsInput(remaining.toString())}
                onChange={(event) => setPaymentAmount(event.target.value)}
                readOnly={!splitPayment}
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

            {retryIntent && retryIntent.saleId === selectedSale?.saleId ? (
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
                paymentBlocked ||
                selectedStatus === "COMPLETED" ||
                remaining <= ZERO ||
                (paymentMethod === "CASH" && !cashSession)
              }
            >
              {paymentLoading ? "Registrando..." : "Registrar pago"}
              <span>-&gt;</span>
            </button>

            {paymentBlocked && selectedSale?.pricingMode === "WHOLESALE" && !selectedSale.wholesaleConfirmed ? (
              <p className="cart-note">Confirmá la venta mayorista para habilitar el cobro.</p>
            ) : paymentBlocked && selectedSale?.holdState === "EXPIRED" ? (
              <p className="cart-note">El stock reservado de esta venta fue liberado: la venta no admite cobros.</p>
            ) : paymentBlocked && selectedSale?.holdState === "COVERAGE_INVALID" ? (
              <p className="cart-note">Las reservas de la venta no son válidas: no admite pagos.</p>
            ) : paymentMethod === "CASH" && !cashSession ? (
              <p className="cart-note">Abre caja antes de registrar pagos en efectivo.</p>
            ) : (
              <p className="cart-note">Cada nuevo intento genera un UUID v4 de idempotencia.</p>
            )}

            <button
              className={selectedSale?.status === "PAID" ? "complete-button primary-cta" : "complete-button"}
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
              <button
                onClick={() => onDecrease(item)}
                disabled={actionLoading}
                aria-label={`Disminuir cantidad de ${item.productName}`}
              >
                -
              </button>
              <span>{item.quantity}</span>
              <button
                onClick={() => onIncrease(item)}
                disabled={actionLoading}
                aria-label={`Aumentar cantidad de ${item.productName}`}
              >
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
  known,
  startingCash,
  closingCash,
  loading,
  onStartingCashChange,
  onClosingCashChange,
  onOpen,
  onClose,
  confirm,
  onConfirmClose,
  onCancelClose,
}: {
  register: CashRegister | null;
  session: CashSession | null;
  known: boolean;
  startingCash: string;
  closingCash: string;
  loading: boolean;
  onStartingCashChange: (value: string) => void;
  onClosingCashChange: (value: string) => void;
  onOpen: () => void;
  onClose: () => void;
  confirm: { sessionId: string; branchId: string; registerName: string; openedAt: string; closingCash: string } | null;
  onConfirmClose: () => void;
  onCancelClose: () => void;
}) {
  return (
    <section className={session ? "cash-session open" : "cash-session"}>
      <div>
        <p className="eyebrow">Estado de caja</p>
        <h2>{session ? "Caja abierta" : known ? "Caja cerrada" : "Verificando caja..."}</h2>
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
              disabled={loading || confirm !== null}
            />
          </label>
          {confirm ? (
            // M2: nothing is reconciled yet; the server computes the expected
            // cash and the difference only when the close is confirmed.
            <div className="close-confirm" role="group" aria-label="Confirmar cierre de caja">
              <p className="eyebrow">Confirmar cierre</p>
              <p>Sucursal <strong>{confirm.branchId}</strong></p>
              <p>Caja <strong>{confirm.registerName}</strong></p>
              <p>Sesión <strong>{confirm.sessionId}</strong></p>
              <p>Abierta {formatDateTime(confirm.openedAt)}</p>
              <p>Monto contado <strong>{formatMoney(confirm.closingCash)}</strong></p>
              <p className="cart-note">El esperado y la diferencia los calcula el servidor al confirmar.</p>
              <button className="primary-button" onClick={onConfirmClose} disabled={loading}>
                Confirmar cierre
              </button>
              <button className="secondary-button" onClick={onCancelClose} disabled={loading}>
                Cancelar cierre
              </button>
            </div>
          ) : (
            <button className="secondary-button" onClick={onClose} disabled={loading}>
              Cerrar caja
            </button>
          )}
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

function CashMovementPanel({
  canSupervise,
  session,
  movements,
  movementsFailed,
  kind,
  amount,
  reason,
  loading,
  intent,
  retry,
  onKindChange,
  onAmountChange,
  onReasonChange,
  onReview,
  onConfirm,
  onCancel,
  reversalTarget,
  reversalReason,
  reversalPending,
  onStartReversal,
  onReversalReasonChange,
  onConfirmReversal,
  onCancelReversal,
}: {
  // CLIENT-CASH-UX: branch-aware supervisor hint (activeBranchId ∈ the user's
  // cashSupervisorLocationIds). Display-only: the API stays authoritative.
  canSupervise: boolean;
  session: CashSession;
  movements: CashMovement[];
  movementsFailed: boolean;
  kind: CashMovementKind;
  amount: string;
  reason: string;
  loading: boolean;
  intent: CashMovementIntent | null;
  retry: boolean;
  onKindChange: (kind: CashMovementKind) => void;
  onAmountChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onReview: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  reversalTarget: CashMovement | null;
  reversalReason: string;
  reversalPending: boolean;
  onStartReversal: (movement: CashMovement) => void;
  onReversalReasonChange: (value: string) => void;
  onConfirmReversal: () => void;
  onCancelReversal: () => void;
}) {
  const intentLabel = intent?.kind === "WITHDRAWAL" ? "retiro" : "gasto";
  // Display-only eligibility (the API stays authoritative): an exit of the open
  // session that no reversal points at yet — and only where the user acts as
  // the supervisor (the reversal POST is supervisor-only).
  const reversedIds = new Set(movements.map((movement) => movement.reversesMovementId).filter((id): id is string => id !== null));
  const canCorrect = (movement: CashMovement) => canSupervise && session.status === "OPEN"
    && (movement.type === "WITHDRAWAL" || movement.type === "EXPENSE")
    && !reversedIds.has(movement.id);

  return (
    <section className="cash-session open cash-movement-panel">
      <div>
        <p className="eyebrow">Sesión actual</p>
        <h2>Movimientos de caja</h2>
        <p>Sesión {shortId(session.sessionId)}</p>
      </div>

      {intent ? (
        <div className="close-confirm" role="group" aria-label={`Confirmar ${intentLabel}`}>
          <p className="eyebrow">Confirmación de {intentLabel}</p>
          <p>Importe <strong>{formatMoney(intent.amount)}</strong></p>
          <p>Motivo <strong>{intent.reason}</strong></p>
          {intent.kind === "WITHDRAWAL" ? (
            <p className="cart-note">Este retiro requiere supervisor (OWNER o ADMIN con alcance COMPANY).</p>
          ) : null}
          <button className="primary-button" onClick={onConfirm} disabled={loading}>
            {retry ? `Reintentar ${intentLabel}` : `Confirmar ${intentLabel}`}
          </button>
          <button className="secondary-button" onClick={onCancel} disabled={loading}>
            Volver
          </button>
        </div>
      ) : (
        <div className="cash-movement-form">
          <fieldset className="cash-movement-kinds" disabled={loading}>
            <legend>Tipo de movimiento</legend>
            <label>
              <input
                type="radio"
                name="cash-movement-kind"
                value="EXPENSE"
                checked={kind === "EXPENSE"}
                onChange={() => onKindChange("EXPENSE")}
              />
              Gasto
            </label>
            {canSupervise ? (
              <label>
                <input
                  type="radio"
                  name="cash-movement-kind"
                  value="WITHDRAWAL"
                  checked={kind === "WITHDRAWAL"}
                  onChange={() => onKindChange("WITHDRAWAL")}
                />
                Retiro
              </label>
            ) : null}
          </fieldset>
          {kind === "WITHDRAWAL" ? (
            <p className="cart-note">El retiro requiere confirmación de un supervisor (OWNER o ADMIN con alcance COMPANY).</p>
          ) : null}
          <label>
            Importe ARS
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => onAmountChange(event.target.value)}
              disabled={loading}
            />
          </label>
          <label>
            Motivo
            <input
              value={reason}
              maxLength={200}
              onChange={(event) => onReasonChange(event.target.value)}
              disabled={loading}
            />
          </label>
          <button className="secondary-button" onClick={onReview} disabled={loading}>
            Revisar {kind === "WITHDRAWAL" ? "retiro" : "gasto"}
          </button>
        </div>
      )}

      {reversalTarget ? (
        <div className="close-confirm" role="group" aria-label="Corregir movimiento">
          <p className="eyebrow">Corrección de movimiento</p>
          <p>Tipo <strong>{cashMovementLabel(reversalTarget.type)}</strong></p>
          <p>Importe <strong>{formatMoney(reversalTarget.amount)}</strong></p>
          <p>Motivo original <strong>{reversalTarget.reason}</strong></p>
          <p className="cart-note">La corrección requiere supervisor (OWNER o ADMIN con alcance COMPANY).</p>
          <p className="muted">El movimiento original queda visible. Para registrar el importe correcto, cargá un nuevo movimiento después.</p>
          <label>
            Motivo de la corrección
            <input
              value={reversalReason}
              maxLength={200}
              onChange={(event) => onReversalReasonChange(event.target.value)}
              disabled={loading || reversalPending}
            />
          </label>
          <button className="primary-button" onClick={onConfirmReversal} disabled={loading}>
            {reversalPending ? "Reintentar corrección" : "Confirmar corrección"}
          </button>
          <button className="secondary-button" onClick={onCancelReversal} disabled={loading}>
            Cancelar
          </button>
        </div>
      ) : null}

      <div className="cash-movement-history">
        <h3>Movimientos actuales de la sesión</h3>
        {movementsFailed ? (
          <p className="muted">No se pudieron cargar los movimientos de caja.</p>
        ) : movements.length === 0 ? (
          <p className="muted">Todavía no hay movimientos en esta sesión.</p>
        ) : (
          <div className="readonly-items">
            {movements.map((movement) => (
              <div className="readonly-item" key={movement.id}>
                <span>
                  <strong>{cashMovementLabel(movement.type)}</strong>
                  <small>{movement.reason ?? formatDateTime(movement.timestamp)}</small>
                  {movement.reversesMovementId ? <small>Corrige {shortId(movement.reversesMovementId)}</small> : null}
                  {reversedIds.has(movement.id) ? <small className="status-pill">Corregido</small> : null}
                </span>
                <strong>{formatMoney(movement.amount)}</strong>
                {canCorrect(movement) ? (
                  <button
                    className="secondary-button"
                    onClick={() => onStartReversal(movement)}
                    disabled={loading || reversalTarget !== null}
                    aria-label={`Corregir ${movement.reason ?? cashMovementLabel(movement.type)}`}
                  >
                    Corregir
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
