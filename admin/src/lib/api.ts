export type UserContext = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  branchIds: string[];
  permissions: string[];
};

export type Branch = {
  id: string;
  name: string;
  code: string;
  address?: string;
  pointOfSaleNumber?: number;
};

export type DashboardSummary = {
  salesToday: number;
  pendingSalesCount: number;
  revenueToday: string;
  lowStockCount: number;
};

export type SaleStatus = 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED';
export type PaymentMethod = 'CASH' | 'TRANSFER' | 'CARD_DEBIT' | 'CARD_CREDIT' | 'QR';

export type Seller = {
  id: string;
  name: string;
  email: string;
};

export type SaleSummary = {
  id: string;
  saleNumber: string | null;
  branch: Branch;
  seller: Seller;
  status: SaleStatus;
  subtotal: string;
  discountTotal: string;
  total: string;
  createdAt: string;
  paymentSummary: {
    paidAmount: string;
    remainingBalance: string;
    count: number;
    methods: PaymentMethod[];
  };
};

export type SaleItem = {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: string;
  unitPrice: string;
  subtotal: string;
  product?: { id: string; name: string; slug: string };
  variant?: {
    id: string;
    sku: string;
    barcode: string;
    color: string | null;
    size: string | null;
    price: string;
    productId: string;
  };
};

export type SalePayment = {
  id: string;
  method: PaymentMethod;
  amount: string;
  receivedAmount: string | null;
  changeAmount: string | null;
  cashSessionId: string | null;
  idempotencyKey: string;
  paidAt: string;
  cashMovement?: {
    id: string;
    sessionId: string;
    type: string;
    amount: string;
    userId: string;
    timestamp: string;
  } | null;
};

export type SaleDetail = SaleSummary & {
  branchId: string;
  sellerId: string;
  updatedAt: string;
  items: SaleItem[];
  payments: SalePayment[];
  stockMovements: Array<{
    id: string;
    type: string;
    quantityDelta: string;
    userId: string;
    timestamp: string;
  }>;
};

export type InventoryRow = {
  id: string;
  branch: Branch;
  product: { id: string; name: string; slug: string };
  variant: {
    id: string;
    sku: string;
    barcode: string;
    color: string | null;
    size: string | null;
    price: string;
  };
  physical: string;
  reserved: string;
  available: string;
};

export type BackofficeUser = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  roles: Array<{ id: string; code: string; name: string }>;
  branches: Branch[];
};

export type CatalogRef = { id: string; name: string };

export type CatalogVariant = {
  id: string;
  productId: string;
  sku: string;
  barcode: string;
  color: string | null;
  size: string | null;
  price: string;
  isActive: boolean;
};

export type CatalogProduct = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: CatalogRef;
  brand: CatalogRef;
  variants: CatalogVariant[];
};

export type CreateProductBody = { name: string; slug: string; categoryId: string; brandId: string };

export type CreateVariantBody = {
  productId: string;
  sku: string;
  barcode: string;
  color?: string;
  size?: string;
  // Integer cents as strings (BigInt-safe API contract).
  price: string;
  costPrice: string;
};

export type InitialStockBody = { variantId: string; branchId: string; quantity: string };

export type InitialStockResult = {
  inventory: { id: string; variantId: string; branchId: string; physical: string; reserved: string };
  movement: { id: string; type: string; quantityDelta: string };
};

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api/v1';
const UUID = '[0-9a-fA-F-]{36}';
const allowedBackoffice = [
  /^\/backoffice\/dashboard$/,
  /^\/backoffice\/sales(?:\?.*)?$/,
  new RegExp(`^/backoffice/sales/${UUID}$`),
  /^\/backoffice\/inventory(?:\?.*)?$/,
  /^\/backoffice\/branches$/,
  /^\/backoffice\/users$/,
];
// D3 admin catalogue / initial stock. Explicit method + path pairs only;
// the backend remains the authority for every one of them.
const allowedCatalogue: Array<[string, RegExp]> = [
  ['GET', /^\/products(?:\?.*)?$/],
  ['GET', /^\/categories$/],
  ['GET', /^\/brands$/],
  ['POST', /^\/products$/],
  ['POST', /^\/variants$/],
  ['PATCH', new RegExp(`^/variants/${UUID}/price$`)],
  ['POST', /^\/inventory\/initial-stock$/],
];

function assertAllowed(method: string, path: string) {
  const authAllowed =
    (method === 'POST' && path === '/auth/login') ||
    (method === 'GET' && path === '/auth/me');
  const backofficeAllowed = method === 'GET' && allowedBackoffice.some((rule) => rule.test(path));
  const catalogueAllowed = allowedCatalogue.some(([allowedMethod, rule]) => allowedMethod === method && rule.test(path));
  if (!authAllowed && !backofficeAllowed && !catalogueAllowed) {
    throw new Error(`Endpoint no permitido: ${method} ${path}`);
  }
}

function userFacingError(message: string | undefined, fallback: string) {
  const labels: Record<string, string> = {
    Unauthorized: 'No autorizado.',
    Forbidden: 'No tenés permiso para realizar esta acción.',
    'Invalid credentials': 'Usuario o contraseña incorrectos.',
  };
  return message ? (labels[message] ?? message) : fallback;
}

async function request<T>(
  path: string,
  options: RequestInit & { token?: string | null; onUnauthorized?: () => void } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  assertAllowed(method, path);

  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) options.onUnauthorized?.();
  if (!response.ok) {
    const candidate = body as { message?: string; error?: { code?: string; message?: string } };
    const fallback =
      response.status === 401
        ? 'No autorizado.'
        : response.status === 403
          ? 'No tenés permiso para realizar esta acción.'
          : 'Error de API.';
    throw new ApiError(
      response.status,
      userFacingError(candidate.message ?? candidate.error?.message, fallback),
      candidate.error?.code,
    );
  }
  return body as T;
}

function send<T>(method: 'POST' | 'PATCH', path: string, token: string, body: unknown, onUnauthorized: () => void) {
  return request<T>(path, { method, token, onUnauthorized, body: JSON.stringify(body) });
}

export const api = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; user: UserContext }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: (token: string, onUnauthorized: () => void) =>
    request<{ user: UserContext }>('/auth/me', { token, onUnauthorized }),
  dashboard: (token: string, onUnauthorized: () => void) =>
    request<DashboardSummary>('/backoffice/dashboard', { token, onUnauthorized }),
  branches: (token: string, onUnauthorized: () => void) =>
    request<{ items: Branch[] }>('/backoffice/branches', { token, onUnauthorized }),
  sales: (token: string, params: URLSearchParams, onUnauthorized: () => void) => {
    const query = params.toString();
    return request<{ items: SaleSummary[]; pagination: { limit: number; offset: number } }>(
      `/backoffice/sales${query ? `?${query}` : ''}`,
      { token, onUnauthorized },
    );
  },
  saleDetail: (token: string, id: string, onUnauthorized: () => void) =>
    request<{ sale: SaleDetail }>(`/backoffice/sales/${id}`, { token, onUnauthorized }),
  inventory: (token: string, params: URLSearchParams, onUnauthorized: () => void) => {
    const query = params.toString();
    return request<{ items: InventoryRow[]; pagination: { limit: number; offset: number; total: number } }>(
      `/backoffice/inventory${query ? `?${query}` : ''}`,
      { token, onUnauthorized },
    );
  },
  users: (token: string, onUnauthorized: () => void) =>
    request<{ items: BackofficeUser[] }>('/backoffice/users', { token, onUnauthorized }),
  products: (token: string, params: URLSearchParams, onUnauthorized: () => void) => {
    const query = params.toString();
    return request<{ items: CatalogProduct[]; pagination: { page: number; limit: number; total: number } }>(
      `/products${query ? `?${query}` : ''}`,
      { token, onUnauthorized },
    );
  },
  categories: (token: string, onUnauthorized: () => void) =>
    request<{ items: CatalogRef[] }>('/categories', { token, onUnauthorized }),
  brands: (token: string, onUnauthorized: () => void) =>
    request<{ items: CatalogRef[] }>('/brands', { token, onUnauthorized }),
  createProduct: (token: string, body: CreateProductBody, onUnauthorized: () => void) =>
    send<{ product: Omit<CatalogProduct, 'category' | 'brand' | 'variants' | 'description'> }>(
      'POST', '/products', token, body, onUnauthorized,
    ),
  createVariant: (token: string, body: CreateVariantBody, onUnauthorized: () => void) =>
    send<{ variant: CatalogVariant & { costPrice: string } }>('POST', '/variants', token, body, onUnauthorized),
  updateVariantPrice: (token: string, variantId: string, price: string, onUnauthorized: () => void) =>
    send<{ variant: CatalogVariant & { costPrice: string } }>(
      'PATCH', `/variants/${variantId}/price`, token, { price }, onUnauthorized,
    ),
  loadInitialStock: (token: string, body: InitialStockBody, onUnauthorized: () => void) =>
    send<InitialStockResult>('POST', '/inventory/initial-stock', token, body, onUnauthorized),
};
