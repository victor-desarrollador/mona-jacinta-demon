import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { assertBranchAccess } from '../../middleware/authorization.js';
import { AppError } from '../../shared/errors.js';

type RequestLike = Parameters<typeof assertBranchAccess>[0];
type BackofficeDatabase = PrismaClient;

export type ListSalesFilters = {
  branchId?: string;
  sellerId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit: number;
  offset: number;
};

export type InventoryFilters = {
  branchId?: string;
  search?: string;
  limit: number;
  offset: number;
};

function scopeBranches(req: RequestLike, branchId?: string) {
  if (branchId) {
    assertBranchAccess(req, branchId);
    return [branchId];
  }
  return req.auth?.branchIds ?? [];
}

function todayBounds(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

const branchSelect = { id: true, name: true, code: true } as const;
const sellerSelect = { id: true, name: true, email: true } as const;

const saleItemSelect = {
  id: true,
  productId: true,
  variantId: true,
  productName: true,
  variantName: true,
  sku: true,
  quantity: true,
  unitPrice: true,
  subtotal: true,
  product: { select: { id: true, name: true, slug: true } },
  variant: {
    select: {
      id: true,
      sku: true,
      barcode: true,
      color: true,
      size: true,
      price: true,
      productId: true,
    },
  },
} satisfies Prisma.SaleItemSelect;

function saleWhere(branchIds: string[], filters: ListSalesFilters) {
  return {
    branchId: { in: branchIds },
    ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
    ...((filters.dateFrom || filters.dateTo)
      ? {
          createdAt: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            ...(filters.dateTo ? { lte: filters.dateTo } : {}),
          },
        }
      : {}),
  } satisfies Prisma.SaleWhereInput;
}

export function createBackofficeService(database: BackofficeDatabase) {
  async function dashboard(req: RequestLike) {
    const branchIds = scopeBranches(req);
    const { start, end } = todayBounds();
    const todayWhere = {
      branchId: { in: branchIds },
      createdAt: { gte: start, lt: end },
    } satisfies Prisma.SaleWhereInput;
    const lowStockWhere = {
      branchId: { in: branchIds },
      physical: { gt: 0n, lte: 3n },
    } satisfies Prisma.InventoryWhereInput;

    const [salesToday, pendingSalesCount, revenue, lowStockCount] = await Promise.all([
      database.sale.count({ where: todayWhere }),
      database.sale.count({ where: { branchId: { in: branchIds }, status: 'PENDING_PAYMENT' } }),
      database.sale.aggregate({
        where: { ...todayWhere, status: { in: ['PAID', 'COMPLETED'] } },
        _sum: { total: true },
      }),
      database.inventory.count({ where: lowStockWhere }),
    ]);

    return {
      salesToday,
      pendingSalesCount,
      revenueToday: revenue._sum.total ?? 0n,
      lowStockCount,
    };
  }

  async function listSales(req: RequestLike, filters: ListSalesFilters) {
    const branchIds = scopeBranches(req, filters.branchId);
    const where = saleWhere(branchIds, filters);
    const sales = await database.sale.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: filters.offset,
      take: filters.limit,
      select: {
        id: true,
        saleNumber: true,
        status: true,
        subtotal: true,
        discountTotal: true,
        total: true,
        createdAt: true,
        branch: { select: branchSelect },
        seller: { select: sellerSelect },
        payments: {
          select: { id: true, method: true, amount: true, receivedAmount: true, changeAmount: true },
          orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    return {
      items: sales.map((sale) => {
        const paidAmount = sale.payments.reduce((sum, payment) => sum + payment.amount, 0n);
        return {
          id: sale.id,
          saleNumber: sale.saleNumber,
          branch: sale.branch,
          seller: sale.seller,
          status: sale.status,
          subtotal: sale.subtotal,
          discountTotal: sale.discountTotal,
          total: sale.total,
          createdAt: sale.createdAt,
          paymentSummary: {
            paidAmount,
            remainingBalance: sale.total - paidAmount,
            count: sale.payments.length,
            methods: [...new Set(sale.payments.map((payment) => payment.method))],
          },
        };
      }),
      pagination: { limit: filters.limit, offset: filters.offset },
    };
  }

  async function getSale(req: RequestLike, id: string) {
    const sale = await database.sale.findUnique({
      where: { id },
      select: {
        id: true,
        saleNumber: true,
        branchId: true,
        sellerId: true,
        status: true,
        subtotal: true,
        discountTotal: true,
        total: true,
        createdAt: true,
        updatedAt: true,
        branch: { select: branchSelect },
        seller: { select: sellerSelect },
        items: { select: saleItemSelect, orderBy: { id: 'asc' } },
        payments: {
          select: {
            id: true,
            method: true,
            amount: true,
            receivedAmount: true,
            changeAmount: true,
            cashSessionId: true,
            idempotencyKey: true,
            paidAt: true,
            cashMovement: {
              select: { id: true, sessionId: true, type: true, amount: true, userId: true, timestamp: true },
            },
          },
          orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        },
        stockMovements: {
          select: { id: true, type: true, quantityDelta: true, userId: true, timestamp: true },
          orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontro la venta.');
    assertBranchAccess(req, sale.branchId);
    return { sale };
  }

  async function inventory(req: RequestLike, filters: InventoryFilters) {
    const branchIds = scopeBranches(req, filters.branchId);
    const where = {
      branchId: { in: branchIds },
      ...(filters.search
        ? {
            OR: [
              { variant: { sku: { contains: filters.search, mode: 'insensitive' } } },
              { variant: { barcode: { contains: filters.search, mode: 'insensitive' } } },
              { variant: { color: { contains: filters.search, mode: 'insensitive' } } },
              { variant: { size: { contains: filters.search, mode: 'insensitive' } } },
              { variant: { product: { name: { contains: filters.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    } satisfies Prisma.InventoryWhereInput;

    const [rows, total] = await Promise.all([
      database.inventory.findMany({
        where,
        orderBy: [
          { branch: { code: 'asc' } },
          { variant: { product: { name: 'asc' } } },
          { variant: { sku: 'asc' } },
        ],
        skip: filters.offset,
        take: filters.limit,
        select: {
          id: true,
          physical: true,
          reserved: true,
          branch: { select: branchSelect },
          variant: {
            select: {
              id: true,
              sku: true,
              barcode: true,
              color: true,
              size: true,
              price: true,
              product: { select: { id: true, name: true, slug: true } },
            },
          },
        },
      }),
      database.inventory.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        branch: row.branch,
        product: row.variant.product,
        variant: {
          id: row.variant.id,
          sku: row.variant.sku,
          barcode: row.variant.barcode,
          color: row.variant.color,
          size: row.variant.size,
          price: row.variant.price,
        },
        physical: row.physical,
        reserved: row.reserved,
        available: row.physical - row.reserved,
      })),
      pagination: { limit: filters.limit, offset: filters.offset, total },
    };
  }

  async function branches(req: RequestLike) {
    return {
      items: await database.branch.findMany({
        where: { id: { in: scopeBranches(req) } },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        select: { ...branchSelect, address: true, pointOfSaleNumber: true },
      }),
    };
  }

  async function users(req: RequestLike) {
    const branchIds = scopeBranches(req);
    const rows = await database.user.findMany({
      where: { branchRoles: { some: { branchId: { in: branchIds } } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        branchRoles: {
          where: { branchId: { in: branchIds } },
          select: {
            role: { select: { id: true, code: true, name: true } },
            branch: { select: branchSelect },
          },
          orderBy: [{ branch: { code: 'asc' } }, { role: { code: 'asc' } }],
        },
      },
    });

    return {
      items: rows.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        roles: [
          ...new Map(user.branchRoles.map(({ role }) => [role.id, role])).values(),
        ],
        branches: [
          ...new Map(user.branchRoles.map(({ branch }) => [branch.id, branch])).values(),
        ],
      })),
    };
  }

  return { dashboard, listSales, getSale, inventory, branches, users };
}
