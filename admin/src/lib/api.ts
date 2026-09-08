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

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api/v1';
const allowedBackoffice = [
  /^\/backoffice\/dashboard$/,
  /^\/backoffice\/sales(?:\?.*)?$/,
  /^\/backoffice\/sales\/[0-9a-fA-F-]{36}$/,
  /^\/backoffice\/inventory(?:\?.*)?$/,
  /^\/backoffice\/branches$/,
  /^\/backoffice\/users$/,
];

function assertAllowed(method: string, path: string) {
  const authAllowed =
    (method === 'POST' && path === '/auth/login') ||
    (method === 'GET' && path === '/auth/me');
  const backofficeAllowed = method === 'GET' && allowedBackoffice.some((rule) => rule.test(path));
  if (!authAllowed && !backofficeAllowed) {
    throw new Error(`Endpoint no permitido por Task 25: ${method} ${path}`);
  }
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
    const candidate = body as { message?: string; error?: { message?: string } };
    throw new ApiError(response.status, candidate.message ?? candidate.error?.message ?? 'Error de API.');
  }
  return body as T;
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
};
