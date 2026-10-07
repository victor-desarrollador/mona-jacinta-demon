import { createHash, type Hash } from 'node:crypto';
import type { Prisma } from '../src/generated/prisma/client.js';

// V2.3.3 R4 fingerprint core (stream format 3, digest scheme SD1).
//
// The canonical state stream (FINGERPRINT.md of the R3/R4 design) is hashed in MEMORY ONLY: it is written to
// DigestSink instances and nothing else. There is no function in this module that returns stream bytes, no file
// or process or console egress (static gate C23), and DigestSink has exactly write()/end(). Errors raised here use
// constant messages only — never an interpolated value — because rows can contain password hashes, e-mails,
// names and AuditLog JSON (gate C22/C30).
//
// This module is pure: it reads no database, environment or file. The SQL readers that feed it live in
// local-test-fingerprint-reader sections below (they only issue SELECTs on a supplied transaction).

export type FieldType = 'text' | 'int4' | 'int8' | 'bool' | 'tstz' | 'enum' | 'jsonb';
export type ContractColumn = Readonly<{
  relation: string;
  attnum: number;
  name: string;
  type: FieldType;
  formatType: string;
  notNull: boolean;
  hasDefault: boolean;
  enumType: string | null;
  pk: number; // 0 = not part of the primary key, else 1-based position in key order
}>;

export const STREAM_FORMAT = 3;
export const DIGEST_SCHEME = 'MONA/V233/STATE-DIGEST/SD1';
export const PROTECTED_SEARCH_PATH = 'pg_catalog, pg_temp';
export const DEFAULT_MAX_RELATION_BYTES = 64 * 1024 * 1024; // UNPINNED parameter: pin from real LOCAL_TEST sizes (design SCOPE risk)

// GENERATED from the R3 mechanical derivation (derive/inventory.json sha256 c9e3f5d3…03d2e): 155 columns of the 25 protected
// relations, by (relation, attnum). Pinned against schema.prisma and the migration set by tests/local-test-fingerprint.test.ts.
// Row: relation, attnum, column, field type, live format_type, notNull, hasDefault, enum type, primary-key position.
type ContractRow = readonly [string, number, string, FieldType, string, 0 | 1, 0 | 1, string | null, number];
const CONTRACT_ROWS: readonly ContractRow[] = [
  ["AuditLog", 1, "id", "text", "text", 1, 0, null, 1],
  ["AuditLog", 2, "userId", "text", "text", 1, 0, null, 0],
  ["AuditLog", 3, "branchId", "text", "text", 0, 0, null, 0],
  ["AuditLog", 4, "action", "text", "text", 1, 0, null, 0],
  ["AuditLog", 5, "entityType", "text", "text", 1, 0, null, 0],
  ["AuditLog", 6, "entityId", "text", "text", 1, 0, null, 0],
  ["AuditLog", 7, "before", "jsonb", "jsonb", 0, 0, null, 0],
  ["AuditLog", 8, "after", "jsonb", "jsonb", 0, 0, null, 0],
  ["AuditLog", 9, "timestamp", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["Branch", 1, "id", "text", "text", 1, 0, null, 1],
  ["Branch", 2, "name", "text", "text", 1, 0, null, 0],
  ["Branch", 3, "code", "text", "text", 1, 0, null, 0],
  ["Branch", 4, "address", "text", "text", 1, 0, null, 0],
  ["Branch", 5, "pointOfSaleNumber", "int4", "integer", 1, 0, null, 0],
  ["Brand", 1, "id", "text", "text", 1, 0, null, 1],
  ["Brand", 2, "name", "text", "text", 1, 0, null, 0],
  ["CashMovement", 1, "id", "text", "text", 1, 0, null, 1],
  ["CashMovement", 2, "sessionId", "text", "text", 1, 0, null, 0],
  ["CashMovement", 3, "type", "enum", "public.\"CashMovementType\"", 1, 0, "CashMovementType", 0],
  ["CashMovement", 4, "amount", "int8", "bigint", 1, 0, null, 0],
  ["CashMovement", 5, "salePaymentId", "text", "text", 0, 0, null, 0],
  ["CashMovement", 6, "userId", "text", "text", 1, 0, null, 0],
  ["CashMovement", 7, "timestamp", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["CashRegister", 1, "id", "text", "text", 1, 0, null, 1],
  ["CashRegister", 2, "branchId", "text", "text", 1, 0, null, 0],
  ["CashRegister", 3, "name", "text", "text", 1, 0, null, 0],
  ["CashSession", 1, "id", "text", "text", 1, 0, null, 1],
  ["CashSession", 2, "registerId", "text", "text", 1, 0, null, 0],
  ["CashSession", 3, "openedById", "text", "text", 1, 0, null, 0],
  ["CashSession", 4, "openedAt", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["CashSession", 5, "closedById", "text", "text", 0, 0, null, 0],
  ["CashSession", 6, "closedAt", "tstz", "timestamp(3) with time zone", 0, 0, null, 0],
  ["CashSession", 7, "startingCash", "int8", "bigint", 1, 0, null, 0],
  ["CashSession", 8, "status", "enum", "public.\"CashSessionStatus\"", 1, 1, "CashSessionStatus", 0],
  ["Category", 1, "id", "text", "text", 1, 0, null, 1],
  ["Category", 2, "name", "text", "text", 1, 0, null, 0],
  ["Company", 1, "id", "text", "text", 1, 0, null, 1],
  ["Company", 2, "name", "text", "text", 1, 0, null, 0],
  ["Company", 3, "cuit", "text", "text", 1, 0, null, 0],
  ["Company", 4, "address", "text", "text", 1, 0, null, 0],
  ["Company", 5, "isActive", "bool", "boolean", 1, 1, null, 0],
  ["Company", 6, "createdAt", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["CompanyPricingConfig", 1, "id", "text", "text", 1, 0, null, 1],
  ["CompanyPricingConfig", 2, "companyId", "text", "text", 1, 0, null, 0],
  ["CompanyPricingConfig", 3, "listAdjustmentBps", "int4", "integer", 1, 1, null, 0],
  ["CompanyPricingConfig", 4, "creditCardAdjustmentBps", "int4", "integer", 1, 1, null, 0],
  ["CompanyPricingConfig", 5, "debitCardAdjustmentBps", "int4", "integer", 1, 1, null, 0],
  ["CompanyPricingConfig", 6, "bankTransferAdjustmentBps", "int4", "integer", 1, 1, null, 0],
  ["CompanyPricingConfig", 7, "qrAdjustmentBps", "int4", "integer", 1, 1, null, 0],
  ["CompanyPricingConfig", 8, "createdAt", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["CompanyPricingConfig", 9, "updatedAt", "tstz", "timestamp(3) with time zone", 1, 0, null, 0],
  ["Inventory", 1, "id", "text", "text", 1, 0, null, 1],
  ["Inventory", 2, "variantId", "text", "text", 1, 0, null, 0],
  ["Inventory", 3, "branchId", "text", "text", 1, 0, null, 0],
  ["Inventory", 4, "physical", "int8", "bigint", 1, 1, null, 0],
  ["Inventory", 5, "reserved", "int8", "bigint", 1, 1, null, 0],
  ["Location", 1, "id", "text", "text", 1, 0, null, 1],
  ["Location", 2, "companyId", "text", "text", 1, 0, null, 0],
  ["Location", 3, "name", "text", "text", 1, 0, null, 0],
  ["Location", 4, "code", "text", "text", 1, 0, null, 0],
  ["Location", 5, "type", "enum", "public.\"LocationType\"", 1, 0, "LocationType", 0],
  ["Location", 6, "address", "text", "text", 1, 0, null, 0],
  ["Location", 7, "pointOfSaleNumber", "int4", "integer", 1, 0, null, 0],
  ["Location", 8, "isActive", "bool", "boolean", 1, 1, null, 0],
  ["Permission", 1, "id", "text", "text", 1, 0, null, 1],
  ["Permission", 2, "code", "text", "text", 1, 0, null, 0],
  ["Product", 1, "id", "text", "text", 1, 0, null, 1],
  ["Product", 2, "name", "text", "text", 1, 0, null, 0],
  ["Product", 3, "slug", "text", "text", 1, 0, null, 0],
  ["Product", 4, "description", "text", "text", 0, 0, null, 0],
  ["Product", 5, "categoryId", "text", "text", 1, 0, null, 0],
  ["Product", 6, "brandId", "text", "text", 1, 0, null, 0],
  ["Product", 7, "isActive", "bool", "boolean", 1, 1, null, 0],
  ["ProductVariant", 1, "id", "text", "text", 1, 0, null, 1],
  ["ProductVariant", 2, "productId", "text", "text", 1, 0, null, 0],
  ["ProductVariant", 3, "sku", "text", "text", 1, 0, null, 0],
  ["ProductVariant", 4, "barcode", "text", "text", 1, 0, null, 0],
  ["ProductVariant", 5, "color", "text", "text", 0, 0, null, 0],
  ["ProductVariant", 6, "size", "text", "text", 0, 0, null, 0],
  ["ProductVariant", 7, "price", "int8", "bigint", 1, 0, null, 0],
  ["ProductVariant", 8, "costPrice", "int8", "bigint", 1, 0, null, 0],
  ["ProductVariant", 9, "isActive", "bool", "boolean", 1, 1, null, 0],
  ["ProductVariant", 10, "wholesalePrice", "int8", "bigint", 0, 0, null, 0],
  ["ProductVariant", 11, "cashPrice", "int8", "bigint", 0, 0, null, 0],
  ["Role", 1, "id", "text", "text", 1, 0, null, 1],
  ["Role", 2, "code", "text", "text", 1, 0, null, 0],
  ["Role", 3, "name", "text", "text", 1, 0, null, 0],
  ["RolePermission", 1, "roleId", "text", "text", 1, 0, null, 1],
  ["RolePermission", 2, "permissionId", "text", "text", 1, 0, null, 2],
  ["Sale", 1, "id", "text", "text", 1, 0, null, 1],
  ["Sale", 2, "saleNumber", "text", "text", 0, 0, null, 0],
  ["Sale", 3, "branchId", "text", "text", 1, 0, null, 0],
  ["Sale", 4, "sellerId", "text", "text", 1, 0, null, 0],
  ["Sale", 5, "status", "enum", "public.\"SaleStatus\"", 1, 1, "SaleStatus", 0],
  ["Sale", 6, "subtotal", "int8", "bigint", 1, 1, null, 0],
  ["Sale", 7, "discountTotal", "int8", "bigint", 1, 1, null, 0],
  ["Sale", 8, "total", "int8", "bigint", 1, 1, null, 0],
  ["Sale", 9, "createdAt", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["Sale", 10, "updatedAt", "tstz", "timestamp(3) with time zone", 1, 0, null, 0],
  ["Sale", 11, "pricingMode", "enum", "public.\"PriceType\"", 1, 1, "PriceType", 0],
  ["Sale", 12, "wholesaleAuthorizedAt", "tstz", "timestamp(3) with time zone", 0, 0, null, 0],
  ["Sale", 13, "wholesaleConfirmedById", "text", "text", 0, 0, null, 0],
  ["Sale", 14, "wholesaleConfirmedAt", "tstz", "timestamp(3) with time zone", 0, 0, null, 0],
  ["Sale", 15, "paymentStartedAt", "tstz", "timestamp(3) with time zone", 0, 0, null, 0],
  ["Sale", 16, "priceMode", "enum", "public.\"CustomerPriceMode\"", 1, 1, "CustomerPriceMode", 0],
  ["SaleItem", 1, "id", "text", "text", 1, 0, null, 1],
  ["SaleItem", 2, "saleId", "text", "text", 1, 0, null, 0],
  ["SaleItem", 3, "variantId", "text", "text", 1, 0, null, 0],
  ["SaleItem", 4, "productId", "text", "text", 1, 0, null, 0],
  ["SaleItem", 5, "productName", "text", "text", 1, 0, null, 0],
  ["SaleItem", 6, "variantName", "text", "text", 1, 0, null, 0],
  ["SaleItem", 7, "sku", "text", "text", 1, 0, null, 0],
  ["SaleItem", 8, "quantity", "int8", "bigint", 1, 0, null, 0],
  ["SaleItem", 9, "unitPrice", "int8", "bigint", 1, 0, null, 0],
  ["SaleItem", 10, "subtotal", "int8", "bigint", 1, 0, null, 0],
  ["SaleItem", 11, "priceBaseType", "enum", "public.\"PriceType\"", 0, 0, "PriceType", 0],
  ["SaleItem", 12, "priceMode", "enum", "public.\"CustomerPriceMode\"", 0, 0, "CustomerPriceMode", 0],
  ["SaleItem", 13, "baseUnitPrice", "int8", "bigint", 0, 0, null, 0],
  ["SaleItem", 14, "priceAdjustmentBps", "int4", "integer", 0, 0, null, 0],
  ["SaleItem", 15, "pricingConfigId", "text", "text", 0, 0, null, 0],
  ["SaleItem", 16, "pricingConfigUpdatedAt", "tstz", "timestamp(3) with time zone", 0, 0, null, 0],
  ["SaleNumberCounter", 1, "id", "text", "text", 1, 0, null, 1],
  ["SaleNumberCounter", 2, "branchId", "text", "text", 1, 0, null, 0],
  ["SaleNumberCounter", 3, "nextValue", "int8", "bigint", 1, 1, null, 0],
  ["SalePayment", 1, "id", "text", "text", 1, 0, null, 1],
  ["SalePayment", 2, "saleId", "text", "text", 1, 0, null, 0],
  ["SalePayment", 3, "method", "enum", "public.\"PaymentMethod\"", 1, 0, "PaymentMethod", 0],
  ["SalePayment", 4, "amount", "int8", "bigint", 1, 0, null, 0],
  ["SalePayment", 5, "receivedAmount", "int8", "bigint", 0, 0, null, 0],
  ["SalePayment", 6, "changeAmount", "int8", "bigint", 0, 0, null, 0],
  ["SalePayment", 7, "cashSessionId", "text", "text", 0, 0, null, 0],
  ["SalePayment", 8, "idempotencyKey", "text", "text", 1, 0, null, 0],
  ["SalePayment", 9, "paidAt", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["StockMovement", 1, "id", "text", "text", 1, 0, null, 1],
  ["StockMovement", 2, "inventoryId", "text", "text", 1, 0, null, 0],
  ["StockMovement", 3, "type", "enum", "public.\"StockMovementType\"", 1, 0, "StockMovementType", 0],
  ["StockMovement", 4, "quantityDelta", "int8", "bigint", 1, 0, null, 0],
  ["StockMovement", 5, "saleId", "text", "text", 0, 0, null, 0],
  ["StockMovement", 6, "userId", "text", "text", 1, 0, null, 0],
  ["StockMovement", 7, "branchId", "text", "text", 1, 0, null, 0],
  ["StockMovement", 8, "timestamp", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["StockReservation", 1, "id", "text", "text", 1, 0, null, 1],
  ["StockReservation", 2, "saleId", "text", "text", 1, 0, null, 0],
  ["StockReservation", 3, "variantId", "text", "text", 1, 0, null, 0],
  ["StockReservation", 4, "branchId", "text", "text", 1, 0, null, 0],
  ["StockReservation", 5, "quantity", "int8", "bigint", 1, 0, null, 0],
  ["StockReservation", 6, "expiresAt", "tstz", "timestamp(3) with time zone", 1, 0, null, 0],
  ["StockReservation", 7, "status", "enum", "public.\"StockReservationStatus\"", 1, 1, "StockReservationStatus", 0],
  ["User", 1, "id", "text", "text", 1, 0, null, 1],
  ["User", 2, "name", "text", "text", 1, 0, null, 0],
  ["User", 3, "email", "text", "text", 1, 0, null, 0],
  ["User", 4, "passwordHash", "text", "text", 1, 0, null, 0],
  ["User", 5, "isActive", "bool", "boolean", 1, 1, null, 0],
  ["User", 6, "createdAt", "tstz", "timestamp(3) with time zone", 1, 1, null, 0],
  ["User", 7, "updatedAt", "tstz", "timestamp(3) with time zone", 1, 0, null, 0],
  ["UserBranchRole", 1, "id", "text", "text", 1, 0, null, 1],
  ["UserBranchRole", 2, "userId", "text", "text", 1, 0, null, 0],
  ["UserBranchRole", 3, "branchId", "text", "text", 1, 0, null, 0],
  ["UserBranchRole", 4, "roleId", "text", "text", 1, 0, null, 0],
  ["UserRoleScope", 1, "id", "text", "text", 1, 0, null, 1],
  ["UserRoleScope", 2, "userId", "text", "text", 1, 0, null, 0],
  ["UserRoleScope", 3, "roleId", "text", "text", 1, 0, null, 0],
  ["UserRoleScope", 4, "scopeKind", "enum", "public.\"ScopeKind\"", 1, 1, "ScopeKind", 0],
  ["UserRoleScope", 5, "locationId", "text", "text", 0, 0, null, 0],
  ["_prisma_migrations", 1, "id", "text", "character varying(36)", 1, 0, null, 1],
  ["_prisma_migrations", 2, "checksum", "text", "character varying(64)", 1, 0, null, 0],
  ["_prisma_migrations", 3, "finished_at", "tstz", "timestamp with time zone", 0, 0, null, 0],
  ["_prisma_migrations", 4, "migration_name", "text", "character varying(255)", 1, 0, null, 0],
  ["_prisma_migrations", 5, "logs", "text", "text", 0, 0, null, 0],
  ["_prisma_migrations", 6, "rolled_back_at", "tstz", "timestamp with time zone", 0, 0, null, 0],
  ["_prisma_migrations", 7, "started_at", "tstz", "timestamp with time zone", 1, 1, null, 0],
  ["_prisma_migrations", 8, "applied_steps_count", "int4", "integer", 1, 1, null, 0],
];
export const TYPE_CONTRACT_V3: readonly ContractColumn[] = Object.freeze(
  CONTRACT_ROWS.map(([relation, attnum, name, type, formatType, notNull, hasDefault, enumType, pk]) =>
    Object.freeze({ relation, attnum, name, type, formatType, notNull: notNull === 1, hasDefault: hasDefault === 1, enumType, pk })),
);
const rawCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export const PROTECTED_RELATIONS: readonly string[] = Object.freeze([...new Set(TYPE_CONTRACT_V3.map((c) => c.relation))].sort(rawCompare));
export type ProtectedRelation = string;
// Enum types ordered by (namespace, name) raw bytes: the index is the ordinal bound into every enum field.
export const ENUM_TYPES: readonly Readonly<{ name: string; labels: readonly string[] }>[] = Object.freeze([
  ["CashMovementType", ["OPENING","SALE_INCOME","CLOSING","MANUAL"]],
  ["CashSessionStatus", ["OPEN","CLOSED"]],
  ["CustomerPriceMode", ["CASH","LIST","CREDIT_CARD","DEBIT_CARD","BANK_TRANSFER","QR"]],
  ["LocationType", ["RETAIL_BRANCH","CENTRAL_WAREHOUSE"]],
  ["PaymentMethod", ["CASH","TRANSFER","CARD_DEBIT","CARD_CREDIT","QR"]],
  ["PriceType", ["LIST","WHOLESALE"]],
  ["SaleStatus", ["DRAFT","PENDING_PAYMENT","PAID","COMPLETED","CANCELLED"]],
  ["ScopeKind", ["LOCATION","COMPANY"]],
  ["StockMovementType", ["SALE","INITIAL_STOCK"]],
  ["StockReservationStatus", ["ACTIVE","RELEASED","CONSUMED"]],
].map(([name, labels]) => Object.freeze({ name: name as string, labels: Object.freeze(labels as string[]) })));
export const PROTECTED_FUNCTION_NAMES: readonly string[] = Object.freeze(['fn_sale_payment_history', 'fn_sale_payment_truncate_guard', 'fn_sale_wholesale_frozen_after_payment']);

// Canonical text of the protected-domain contract (relations, columns, enum types, functions); its sha256 is bound into witnesses.
export function protectedDomainContractSha256(): string {
  const text = JSON.stringify({
    relations: PROTECTED_RELATIONS,
    columns: TYPE_CONTRACT_V3.map((c) => [c.relation, c.attnum, c.name, c.type, c.formatType, c.notNull, c.hasDefault, c.enumType, c.pk]),
    enums: ENUM_TYPES.map((e) => [e.name, e.labels]),
    functions: PROTECTED_FUNCTION_NAMES,
  });
  return createHash('sha256').update(text).digest('hex');
}

// ---- framing primitives (FINGERPRINT.md §1): unsigned big-endian integers, length-prefixed strings ----
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('fingerprint length out of range');
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const lengthPrefixed = (b: Buffer) => Buffer.concat([u32(b.length), b]);
// A lone surrogate (high not followed by low, or low not preceded by high) is not well-formed UTF-16 text.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (s: unknown): s is string => typeof s === 'string' && !LONE_SURROGATE.test(s);
// A lone surrogate would be silently replaced by U+FFFD when encoded: refuse it instead of hashing a lossy value.
const utf8 = (s: string) => {
  if (!wellFormed(s)) throw new Error('fingerprint text is not well-formed UTF-8');
  return Buffer.from(s, 'utf8');
};
const str = (s: string) => lengthPrefixed(utf8(s));

// ---- the only egress of canonical bytes: a hash sink ----
export class DigestSink {
  #hash: Hash;
  #done = false;
  constructor(role: 'PRE' | 'POST') {
    if (role !== 'PRE' && role !== 'POST') throw new Error('unknown digest role');
    this.#hash = createHash('sha256');
    this.#hash.update(str(`${DIGEST_SCHEME}/${role}`));
  }
  write(chunk: Uint8Array): void {
    if (this.#done) throw new Error('digest sink already ended');
    this.#hash.update(chunk);
  }
  end(): string {
    if (this.#done) throw new Error('digest sink already ended');
    this.#done = true;
    return this.#hash.digest('hex');
  }
}

// ---- value encodings (FINGERPRINT.md §3) ----
const DECIMAL = /^(0|-?[1-9][0-9]*)$/; // no leading zeros, no '+', no '-0'
const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
function decimal(text: string, min: bigint, max: bigint): bigint {
  if (typeof text !== 'string' || !DECIMAL.test(text)) throw new Error('fingerprint integer text is not canonical');
  const v = BigInt(text);
  if (v < min || v > max) throw new Error('fingerprint integer out of range');
  return v;
}
const i64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(v);
  return b;
};
const field = (type: FieldType, enumType: string | null, text: string | null, enumLabels: ReadonlyMap<string, readonly string[]>): Buffer => {
  if (text === null) return u8(0);
  switch (type) {
    case 'text':
      return Buffer.concat([u8(1), u8(0x01), lengthPrefixed(utf8(text))]);
    case 'int4': {
      const b = Buffer.alloc(4);
      b.writeInt32BE(Number(decimal(text, INT32_MIN, INT32_MAX)));
      return Buffer.concat([u8(1), u8(0x02), lengthPrefixed(b)]);
    }
    case 'int8': return Buffer.concat([u8(1), u8(0x03), lengthPrefixed(i64(decimal(text, INT64_MIN, INT64_MAX)))]);
    case 'bool':
      if (text !== 'true' && text !== 'false') throw new Error('fingerprint boolean text must be exactly true or false');
      return Buffer.concat([u8(1), u8(0x04), lengthPrefixed(u8(text === 'true' ? 1 : 0))]);
    case 'tstz': {
      if (text === '+infinity') return Buffer.concat([u8(1), u8(0x05), lengthPrefixed(Buffer.concat([u8(0x02), Buffer.alloc(8)]))]);
      if (text === '-infinity') return Buffer.concat([u8(1), u8(0x05), lengthPrefixed(Buffer.concat([u8(0x03), Buffer.alloc(8)]))]);
      return Buffer.concat([u8(1), u8(0x05), lengthPrefixed(Buffer.concat([u8(0x01), i64(decimal(text, INT64_MIN, INT64_MAX))]))]);
    }
    case 'enum': {
      const ordinal = ENUM_TYPES.findIndex((e) => e.name === enumType);
      const labels = enumType === null ? undefined : enumLabels.get(enumType);
      if (ordinal < 0 || !labels || !labels.includes(text)) throw new Error('fingerprint enum value is not a label of its type');
      return Buffer.concat([u8(1), u8(0x06), lengthPrefixed(Buffer.concat([u16(ordinal), str(text)]))]);
    }
    case 'jsonb':
      return Buffer.concat([u8(1), u8(0x07), lengthPrefixed(utf8(text))]);
  }
};

export type StateHeader = Readonly<{
  target: string;
  markerId: string;
  markerInstalledAt: string; // server projection of the marker's installed_at (µs since epoch, or +/-infinity)
  serverVersionNum: string;
  searchPath: string;
  serverEncoding: string;
  clientEncoding: string;
}>;
export type EnumTypeFacts = Readonly<{ schema: string; name: string; labels: readonly string[] }>;
export type FunctionFacts = Readonly<{
  name: string; identityArgs: string; returnType: string; language: string; source: string; config: string;
  securityDefiner: boolean; volatility: string; strict: boolean; kind: string;
}>;
export type RelationFacts = Readonly<{
  relation: string;
  columns: readonly Readonly<{ attnum: number; name: string; formatType: string; notNull: boolean; defaultExpr: string | null; collation: string | null }>[];
  pk: readonly number[];
  constraints: readonly Readonly<{ name: string; type: string; validated: boolean; definition: string }>[];
  indexes: readonly Readonly<{ name: string; definition: string; valid: boolean; ready: boolean }>[];
  triggers: readonly Readonly<{ name: string; enabled: string; definition: string }>[];
  riTriggers: readonly Readonly<{ constraint: string; type: number; func: string; enabled: string }>[];
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  policies: number;
  rules: number;
  inheritanceChildren: number;
  comment: string | null;
}>;
export type CellText = string | null;
// All rows of the protected relations as server-projected text, by relation. Exists only in memory, only inside the
// protected step that reads it (the pre-image P at T8, the post-image Q at T14); never serialised, logged or returned
// across the step boundary except to the in-transaction verifier (gate C30).
export type StateRows = ReadonlyMap<string, readonly (readonly CellText[])[]>;

// The single database capability of the protected phase: a Prisma interactive-transaction client created by the
// transaction owner (local-test-runtime.ts) and wrapped so that transaction control, session SET and client
// construction are unreachable through it. The brand is a compile-time marker; the runtime enforcement is the wrapper.
declare const PROTECTED_TX_BRAND: unique symbol;
export type ProtectedTx = Prisma.TransactionClient & { readonly [PROTECTED_TX_BRAND]: true };

const MARKER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Streams the canonical state into hash sinks, in the fixed order header → types → functions → 25 relations → end.
// Every relation's rows are validated (arity, per-type canonical text, strict ascent in raw UTF-8 byte order of the
// primary key, byte cap) while they are encoded; any violation throws a constant-message error (STOP).
export class StateStreamWriter {
  readonly #sinks: readonly DigestSink[];
  readonly #maxRelationBytes: number;
  // Schema-only digest (header, types, functions, relation metadata; NOT rows): held in memory for the pre/post schema
  // equality check and the post-dump stability check. It is never persisted (evidence minimization).
  readonly #schema: Hash = createHash('sha256').update(lengthPrefixed(Buffer.from(`${DIGEST_SCHEME}/SCHEMA`, 'utf8')));
  #stage: 'header' | 'types' | 'functions' | 'relations' | 'finished' = 'header';
  #relationIndex = 0;
  readonly #enumLabels = new Map<string, readonly string[]>();
  constructor(sinks: readonly DigestSink[], options: Readonly<{ maxRelationBytes?: number }> = {}) {
    if (!Array.isArray(sinks) || sinks.length === 0) throw new Error('fingerprint needs at least one sink');
    this.#sinks = sinks;
    this.#maxRelationBytes = options.maxRelationBytes ?? DEFAULT_MAX_RELATION_BYTES;
  }
  #emit(chunk: Buffer, schema = false) {
    for (const sink of this.#sinks) sink.write(chunk);
    if (schema) this.#schema.update(chunk);
  }
  header(h: StateHeader): void {
    if (this.#stage !== 'header') throw new Error('fingerprint header out of order');
    if (h.searchPath !== PROTECTED_SEARCH_PATH) throw new Error('fingerprint search_path is not the protected path');
    if (h.serverEncoding !== 'UTF8' || h.clientEncoding !== 'UTF8') throw new Error('fingerprint encodings must be UTF8');
    if (!MARKER_UUID.test(h.markerId) || !/^[0-9]{5,6}$/.test(h.serverVersionNum)) throw new Error('fingerprint header fact is malformed');
    const installed = field('tstz', null, h.markerInstalledAt, this.#enumLabels);
    this.#emit(Buffer.concat([Buffer.from('MJFP', 'latin1'), u16(STREAM_FORMAT), str(h.target), str(h.markerId), installed, str(h.serverVersionNum), str(h.searchPath), str(h.serverEncoding), str(h.clientEncoding)]), true);
    this.#stage = 'types';
  }
  types(list: readonly EnumTypeFacts[]): void {
    if (this.#stage !== 'types') throw new Error('fingerprint types out of order');
    if (list.length !== ENUM_TYPES.length || list.some((t, i) => t.schema !== 'public' || t.name !== ENUM_TYPES[i]?.name)) throw new Error('fingerprint enum types differ from the contract');
    const parts: Buffer[] = [u32(list.length)];
    for (const t of list) {
      this.#enumLabels.set(t.name, t.labels);
      parts.push(str(t.schema), str(t.name), u32(t.labels.length));
      for (const label of t.labels) parts.push(str(label));
    }
    this.#emit(Buffer.concat(parts), true);
    this.#stage = 'functions';
  }
  functions(list: readonly FunctionFacts[]): void {
    if (this.#stage !== 'functions') throw new Error('fingerprint functions out of order');
    if (list.length !== PROTECTED_FUNCTION_NAMES.length || list.some((f, i) => f.name !== PROTECTED_FUNCTION_NAMES[i])) throw new Error('fingerprint functions differ from the contract');
    const parts: Buffer[] = [u32(list.length)];
    for (const f of list) {
      parts.push(str(f.name), str(f.identityArgs), str(f.returnType), str(f.language), str(f.source), str(f.config), u8(f.securityDefiner ? 1 : 0), str(f.volatility), u8(f.strict ? 1 : 0), str(f.kind));
    }
    parts.push(u32(PROTECTED_RELATIONS.length));
    this.#emit(Buffer.concat(parts), true);
    this.#stage = 'relations';
  }
  relation(facts: RelationFacts, rows: readonly (readonly CellText[])[]): void {
    if (this.#stage !== 'relations') throw new Error('fingerprint relation out of order');
    const expected = PROTECTED_RELATIONS[this.#relationIndex];
    if (expected === undefined || facts.relation !== expected) throw new Error('fingerprint relation out of order');
    const contract = TYPE_CONTRACT_V3.filter((c) => c.relation === expected);
    const pkAttnums = contract.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.attnum);
    const sameColumns = facts.columns.length === contract.length && facts.columns.every((c, i) => {
      const k = contract[i] as ContractColumn;
      return c.attnum === k.attnum && c.name === k.name && c.formatType === k.formatType && c.notNull === k.notNull && (c.defaultExpr !== null) === k.hasDefault;
    });
    if (!sameColumns || facts.pk.length !== pkAttnums.length || facts.pk.some((a, i) => a !== pkAttnums[i])) throw new Error('fingerprint columns differ from the contract');
    if (facts.rowSecurity || facts.forceRowSecurity || facts.policies !== 0 || facts.rules !== 0 || facts.inheritanceChildren !== 0) throw new Error('fingerprint relation has RLS, policies, rules or inheritance');
    const head: Buffer[] = [str('public'), str(facts.relation), u32(facts.columns.length)];
    for (const c of facts.columns) head.push(u16(c.attnum), str(c.name), str(c.formatType), u8(c.notNull ? 1 : 0), str(c.defaultExpr ?? ''), str(c.collation ?? ''));
    head.push(u32(facts.pk.length));
    for (const a of facts.pk) head.push(u16(a));
    head.push(u32(facts.constraints.length));
    for (const c of facts.constraints) head.push(str(c.name), str(c.type), u8(c.validated ? 1 : 0), str(c.definition));
    head.push(u32(facts.indexes.length));
    for (const i of facts.indexes) head.push(str(i.name), str(i.definition), u8(i.valid ? 1 : 0), u8(i.ready ? 1 : 0));
    head.push(u32(facts.triggers.length));
    for (const t of facts.triggers) head.push(str(t.name), str(t.enabled), str(t.definition));
    head.push(u32(facts.riTriggers.length));
    for (const t of facts.riTriggers) head.push(str(t.constraint), u16(t.type), str(t.func), str(t.enabled));
    head.push(u8(0), u8(0), u32(0), u32(0), u32(0), str(facts.comment ?? ''));
    const headBuffer = Buffer.concat(head);
    const countBuffer = u64(rows.length);
    let relationBytes = headBuffer.length + countBuffer.length;
    this.#emit(headBuffer, true);
    this.#emit(countBuffer);
    const pkColumnIndexes = pkAttnums.map((a) => contract.findIndex((c) => c.attnum === a));
    let previous: Buffer[] | null = null;
    for (const row of rows) {
      if (row.length !== contract.length) throw new Error('fingerprint row arity differs from the contract');
      const key = pkColumnIndexes.map((i) => {
        const v = row[i];
        if (typeof v !== 'string' || !wellFormed(v)) throw new Error('fingerprint primary key must be non-null text');
        return Buffer.from(v, 'utf8');
      });
      if (previous !== null && compareKeys(previous, key) >= 0) throw new Error('fingerprint rows are not strictly ascending in raw byte order');
      previous = key;
      const parts: Buffer[] = [u8(0x52)];
      row.forEach((v, i) => {
        const c = contract[i] as ContractColumn;
        parts.push(field(c.type, c.enumType, v ?? null, this.#enumLabels));
      });
      const encoded = Buffer.concat(parts);
      relationBytes += encoded.length;
      if (relationBytes > this.#maxRelationBytes) throw new Error('fingerprint relation exceeds the byte cap');
      this.#emit(encoded);
    }
    this.#relationIndex += 1;
  }
  // Completes the stream and returns the in-memory schema-only digest (never the stream, never persisted).
  finish(): string {
    if (this.#stage !== 'relations' || this.#relationIndex !== PROTECTED_RELATIONS.length) throw new Error('fingerprint is incomplete');
    this.#emit(Buffer.from('END', 'latin1'));
    this.#stage = 'finished';
    return this.#schema.digest('hex');
  }
}
function compareKeys(a: readonly Buffer[], b: readonly Buffer[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const c = Buffer.compare(a[i] as Buffer, b[i] as Buffer);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

// ---- live metadata checks (run BEFORE any stream byte is produced) ----
export type LiveColumnRow = Readonly<{
  relname: string; attnum: number; attname: string; formatType: string; notNull: boolean; hasDefault: boolean; defaultExpr: string | null;
  generated: string; identity: string; collation: string | null; typtype: string; typnsp: string; typname: string;
}>;
export function assertLiveTypeContract(rows: readonly LiveColumnRow[]): void {
  if (rows.length !== TYPE_CONTRACT_V3.length) throw new Error('live column set differs from the type contract');
  const seen = new Set<string>();
  for (const r of rows) {
    const c = TYPE_CONTRACT_V3.find((k) => k.relation === r.relname && k.attnum === r.attnum);
    const key = `${r.relname}\u0000${r.attnum}`;
    if (!c || seen.has(key)) throw new Error('live column set differs from the type contract');
    seen.add(key);
    const typeOk = c.type === 'enum' ? r.typtype === 'e' && r.typnsp === 'public' && r.typname === c.enumType : r.typtype === 'b' && r.typnsp === 'pg_catalog';
    if (r.attname !== c.name || r.formatType !== c.formatType || r.notNull !== c.notNull || r.hasDefault !== c.hasDefault || r.generated !== '' || r.identity !== '' || !typeOk) {
      throw new Error('live column differs from the type contract');
    }
  }
}

export type LiveRelationDomainRow = Readonly<{
  relname: string; relkind: string; persistence: string; isPartition: boolean; hasSubclass: boolean; inheritanceRows: number;
  rowSecurity: boolean; forceRowSecurity: boolean; hasRules: boolean; ownerIsCurrentUser: boolean; policies: number;
}>;
export function assertRelationDomainFacts(rows: readonly LiveRelationDomainRow[]): void {
  if (rows.length !== PROTECTED_RELATIONS.length) throw new Error('live relation set differs from the protected domain');
  const names = new Set(rows.map((r) => r.relname));
  if (names.size !== rows.length || PROTECTED_RELATIONS.some((n) => !names.has(n))) throw new Error('live relation set differs from the protected domain');
  for (const r of rows) {
    if (r.relkind !== 'r' || r.persistence !== 'p' || r.isPartition || r.hasSubclass || r.inheritanceRows !== 0 || r.rowSecurity || r.forceRowSecurity || r.hasRules || !r.ownerIsCurrentUser || r.policies !== 0) {
      throw new Error('a protected relation is not an ordinary table of the protected domain');
    }
  }
}

// ===== SQL readers on a supplied protected transaction (SELECT only; run after the owner's locks) =====
//
// Every statement is fully qualified (pg_catalog.*, public."X", mona_local_test_guard.*) because the protected
// search_path is `pg_catalog, pg_temp`; every protected value is projected AS TEXT by the server so the Prisma adapter
// applies no parser (no BigInt/JSON/Date conversion); no value is ever embedded in a statement (the only literals are
// the relation names of the contract). A reader failure surfaces a constant message only — never statement text,
// parameters or driver detail (rows can contain protected values).

const sqlList = (names: readonly string[]) => names.map((n) => `'${n}'`).join(', ');
const RELATION_LIST = sqlList(PROTECTED_RELATIONS);
const FROM_PUBLIC_CLASS = `FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`;
const tstzProjection = (column: string) =>
  `CASE WHEN "${column}" = 'infinity'::pg_catalog.timestamptz THEN '+infinity' WHEN "${column}" = '-infinity'::pg_catalog.timestamptz THEN '-infinity' ELSE ((EXTRACT(EPOCH FROM "${column}") * 1000000)::pg_catalog.numeric(20,0))::pg_catalog.text END`;

const FINGERPRINT_SQL_BY_NAME = Object.freeze({
  settings: `SELECT name::pg_catalog.text AS name, setting::pg_catalog.text AS setting FROM pg_catalog.pg_settings WHERE name IN ('search_path', 'transaction_isolation', 'server_encoding', 'client_encoding', 'session_replication_role', 'standard_conforming_strings', 'synchronous_commit', 'fsync', 'TimeZone', 'lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout')`,
  ownTemp: `SELECT (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = pg_catalog.pg_my_temp_schema())::pg_catalog.text AS temp_classes, (SELECT count(*) FROM pg_catalog.pg_type WHERE typnamespace = pg_catalog.pg_my_temp_schema())::pg_catalog.text AS temp_types`,
  extraRelations: `SELECT count(*)::pg_catalog.text AS extra_relations ${FROM_PUBLIC_CLASS} WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c') AND c.relname NOT IN (${RELATION_LIST})`,
  domain: `SELECT c.relname::pg_catalog.text AS relname, c.relkind::pg_catalog.text AS relkind, c.relpersistence::pg_catalog.text AS persistence, c.relispartition::pg_catalog.text AS is_partition, c.relhassubclass::pg_catalog.text AS has_subclass, (SELECT count(*) FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid)::pg_catalog.text AS inheritance_rows, c.relrowsecurity::pg_catalog.text AS row_security, c.relforcerowsecurity::pg_catalog.text AS force_row_security, c.relhasrules::pg_catalog.text AS has_rules, (pg_catalog.pg_get_userbyid(c.relowner) = current_user)::pg_catalog.text AS owner_is_current_user, (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)::pg_catalog.text AS policies ${FROM_PUBLIC_CLASS} WHERE n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) ORDER BY c.relname COLLATE "C"`,
  columns: `SELECT c.relname::pg_catalog.text AS relname, a.attnum::pg_catalog.text AS attnum, a.attname::pg_catalog.text AS attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS format_type, a.attnotnull::pg_catalog.text AS not_null, a.atthasdef::pg_catalog.text AS has_default, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attgenerated::pg_catalog.text AS generated, a.attidentity::pg_catalog.text AS identity, co.collname::pg_catalog.text AS collation, t.typtype::pg_catalog.text AS typtype, tn.nspname::pg_catalog.text AS typnsp, t.typname::pg_catalog.text AS typname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_type t ON t.oid = a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation WHERE n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname COLLATE "C", a.attnum`,
  marker: `SELECT marker_id::pg_catalog.text AS marker_id, ${tstzProjection('installed_at')} AS installed_at, pg_catalog.current_setting('server_version_num') AS server_version_num, pg_catalog.current_setting('search_path') AS search_path, pg_catalog.current_setting('server_encoding') AS server_encoding, pg_catalog.current_setting('client_encoding') AS client_encoding FROM mona_local_test_guard.database_identity`,
  enums: `SELECT n.nspname::pg_catalog.text AS nspname, t.typname::pg_catalog.text AS typname, e.enumlabel::pg_catalog.text AS label FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY n.nspname COLLATE "C", t.typname COLLATE "C", e.enumsortorder`,
  functions: `SELECT p.proname::pg_catalog.text AS proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_args, p.prorettype::pg_catalog.regtype::pg_catalog.text AS return_type, l.lanname::pg_catalog.text AS language, p.prosrc AS source, pg_catalog.array_to_string(p.proconfig, E'\\n') AS config, p.prosecdef::pg_catalog.text AS security_definer, p.provolatile::pg_catalog.text AS volatility, p.proisstrict::pg_catalog.text AS strict, p.prokind::pg_catalog.text AS kind FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE n.nspname = 'public' ORDER BY p.proname COLLATE "C", pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
  primaryKeys: `SELECT c.relname::pg_catalog.text AS relname, k.attnum::pg_catalog.text AS attnum, k.ord::pg_catalog.text AS ord FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.unnest(i.indkey::pg_catalog.int2[]) WITH ORDINALITY AS k(attnum, ord) WHERE i.indisprimary AND n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) ORDER BY c.relname COLLATE "C", k.ord`,
  constraints: `SELECT c.relname::pg_catalog.text AS relname, con.conname::pg_catalog.text AS conname, con.contype::pg_catalog.text AS contype, con.convalidated::pg_catalog.text AS validated, pg_catalog.pg_get_constraintdef(con.oid) AS definition FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) AND con.contype <> 'n' ORDER BY c.relname COLLATE "C", con.conname COLLATE "C"`,
  indexes: `SELECT c.relname::pg_catalog.text AS relname, ic.relname::pg_catalog.text AS indexname, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid::pg_catalog.text AS valid, i.indisready::pg_catalog.text AS ready FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) ORDER BY c.relname COLLATE "C", ic.relname COLLATE "C"`,
  triggers: `SELECT c.relname::pg_catalog.text AS relname, t.tgname::pg_catalog.text AS tgname, t.tgenabled::pg_catalog.text AS enabled, pg_catalog.pg_get_triggerdef(t.oid) AS definition FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) AND NOT t.tgisinternal ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`,
  riTriggers: `SELECT c.relname::pg_catalog.text AS relname, con.conname::pg_catalog.text AS conname, t.tgtype::pg_catalog.text AS tgtype, t.tgfoid::pg_catalog.regproc::pg_catalog.text AS func, t.tgenabled::pg_catalog.text AS enabled FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_constraint con ON con.oid = t.tgconstraint WHERE n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) AND t.tgisinternal ORDER BY c.relname COLLATE "C", con.conname COLLATE "C", t.tgtype`,
  comments: `SELECT c.relname::pg_catalog.text AS relname, pg_catalog.obj_description(c.oid, 'pg_class') AS comment ${FROM_PUBLIC_CLASS} WHERE n.nspname = 'public' AND c.relname IN (${RELATION_LIST}) ORDER BY c.relname COLLATE "C"`,
});
export type FingerprintReadName = keyof typeof FINGERPRINT_SQL_BY_NAME;
export const FINGERPRINT_SQL: Readonly<Record<string, string>> = FINGERPRINT_SQL_BY_NAME;

const LOCAL_GUARD_SCHEMA = 'mona_local_test_guard';
const LOCAL_GUARD_TABLE = 'database_identity';
const LOCAL_QUALIFIED = `${LOCAL_GUARD_SCHEMA}.${LOCAL_GUARD_TABLE}`;
const LOCAL_REL = `to_regclass('${LOCAL_QUALIFIED}')`;
export const LOCAL_TEST_LIVE_FACTS_SQL = `SELECT current_database() AS current_database, current_user AS current_user, version() AS version,
  to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard_exists,
  to_regnamespace('mona_pilot_guard') IS NOT NULL AS pilot_guard_exists`;
export const LOCAL_TEST_MARKER_FACTS_SQL = `SELECT json_build_object(
  'schemaOwnerIsCurrentUser', (SELECT pg_get_userbyid(n.nspowner) = current_user
     FROM pg_namespace n WHERE n.nspname = '${LOCAL_GUARD_SCHEMA}'),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', c.relname, 'kind', c.relkind)), '[]'::json)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${LOCAL_GUARD_SCHEMA}'),
  'table', (SELECT json_build_object(
       'kind', c.relkind,
       'persistence', c.relpersistence,
       'isPartition', c.relispartition,
       'ofType', c.reloftype <> 0,
       'ownerIsCurrentUser', pg_get_userbyid(c.relowner) = current_user,
       'rowSecurity', c.relrowsecurity,
       'forceRowSecurity', c.relforcerowsecurity,
       'hasSubclass', c.relhassubclass,
       'parents', (SELECT count(*) FROM pg_inherits i WHERE i.inhrelid = c.oid),
       'children', (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid),
       'hasRules', c.relhasrules,
       'triggers', (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid))
     FROM pg_class c WHERE c.oid = ${LOCAL_REL}),
  'columns', (SELECT coalesce(json_agg(json_build_object(
       'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
       'default', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated, 'identity', a.attidentity,
       'collation', (SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation))
       ORDER BY a.attnum), '[]'::json)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ${LOCAL_REL} AND a.attnum > 0 AND NOT a.attisdropped),
  'constraints', (SELECT coalesce(json_agg(json_build_object('type', con.contype, 'definition', pg_get_constraintdef(con.oid))), '[]'::json)
     FROM pg_constraint con WHERE con.conrelid = ${LOCAL_REL} AND con.contype <> 'n')
) AS facts`;
export const LOCAL_TEST_MARKER_SQL =
  'SELECT environment, marker_id::text AS marker_id, installed_at IS NOT NULL AS has_installed_at FROM mona_local_test_guard.database_identity';
export type IdentityReadName = 'liveFacts' | 'markerFacts' | 'markerRows';

// The rows of one relation: `FROM ONLY` (inheritance children never leak in), every column projected as text, ordered by
// the primary key in raw byte order (COLLATE "C"). Column aliases are positional (c1..cn) in contract order.
export function relationRowsSql(relation: string): string {
  const columns = TYPE_CONTRACT_V3.filter((c) => c.relation === relation);
  if (columns.length === 0) throw new Error('unknown protected relation');
  const projections = columns.map((c, i) => `${c.type === 'tstz' ? tstzProjection(c.name) : `"${c.name}"::pg_catalog.text`} AS c${i + 1}`);
  const order = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => `"${c.name}" COLLATE "C"`);
  return `SELECT ${projections.join(', ')} FROM ONLY public."${relation}" ORDER BY ${order.join(', ')}`;
}

type RawRow = Record<string, unknown>;
type Reader = { $queryRawUnsafe: (sql: string) => Promise<RawRow[]> };
const READ_FAILED = 'protected state read failed';
const reader = (tx: ProtectedTx): Reader => tx as unknown as Reader;
export type ProtectedReadSpec =
  | Readonly<{ kind: 'fingerprint'; query: FingerprintReadName }>
  | Readonly<{ kind: 'relationRows'; relation: ProtectedRelation }>
  | Readonly<{ kind: 'identity'; query: IdentityReadName }>;
const protectedReadSql = (spec: ProtectedReadSpec): string => {
  if (spec.kind === 'fingerprint') {
    const sql = FINGERPRINT_SQL_BY_NAME[spec.query];
    if (!sql) throw new Error(READ_FAILED);
    return sql;
  }
  if (spec.kind === 'relationRows') return relationRowsSql(spec.relation);
  if (spec.kind === 'identity') {
    if (spec.query === 'liveFacts') return LOCAL_TEST_LIVE_FACTS_SQL;
    if (spec.query === 'markerFacts') return LOCAL_TEST_MARKER_FACTS_SQL;
    if (spec.query === 'markerRows') return LOCAL_TEST_MARKER_SQL;
  }
  throw new Error(READ_FAILED);
};
export const readProtectedRows = async (tx: ProtectedTx, spec: ProtectedReadSpec): Promise<RawRow[]> => {
  const rows = await reader(tx).$queryRawUnsafe(protectedReadSql(spec));
  if (!Array.isArray(rows)) throw new Error(READ_FAILED);
  return rows;
};
const text = (row: RawRow, key: string): string => {
  const v = row[key];
  if (typeof v !== 'string') throw new Error(READ_FAILED);
  return v;
};
const optText = (row: RawRow, key: string): string | null => {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error(READ_FAILED);
  return v;
};
const bool = (row: RawRow, key: string): boolean => {
  const v = text(row, key);
  if (v !== 'true' && v !== 'false') throw new Error(READ_FAILED);
  return v === 'true';
};
const int = (row: RawRow, key: string): number => {
  const v = text(row, key);
  if (!/^[0-9]{1,9}$/.test(v)) throw new Error(READ_FAILED);
  return Number(v);
};
// The protected settings by profile. 'resume' is the write transaction (durability premise of an acknowledged COMMIT:
// synchronous_commit and fsync on); the read-only profiles do not require it. All profiles pin search_path, encodings,
// replication role, standard_conforming_strings, the session zone and the finite timeouts (ms, the pg_settings base unit).
export type SettingsProfile = 'resume' | 'outcome' | 'snapshot' | 'stability';
const COMMON_SETTINGS = {
  search_path: PROTECTED_SEARCH_PATH,
  server_encoding: 'UTF8',
  client_encoding: 'UTF8',
  session_replication_role: 'origin',
  standard_conforming_strings: 'on',
  TimeZone: 'UTC', // seed #2 writes zone-less Date text: the session zone must be UTC (pinned by the owner)
  lock_timeout: '10000',
  statement_timeout: '120000',
} as const;
const EXPECTED_SETTINGS: Readonly<Record<SettingsProfile, Readonly<Record<string, string>>>> = Object.freeze({
  resume: Object.freeze({ ...COMMON_SETTINGS, transaction_isolation: 'read committed', synchronous_commit: 'on', fsync: 'on', idle_in_transaction_session_timeout: '180000' }),
  outcome: Object.freeze({ ...COMMON_SETTINGS, transaction_isolation: 'repeatable read', idle_in_transaction_session_timeout: '180000' }),
  snapshot: Object.freeze({ ...COMMON_SETTINGS, transaction_isolation: 'repeatable read', idle_in_transaction_session_timeout: '900000' }),
  stability: Object.freeze({ ...COMMON_SETTINGS, transaction_isolation: 'read committed', idle_in_transaction_session_timeout: '180000' }),
});

// T5 and the re-proofs (before seed, before the verifier, immediately before COMMIT): every protected setting has its
// reviewed value for the profile. A missing row is a refusal. Throws a constant message only.
export async function proveSettingsOnTransaction(tx: ProtectedTx, profile: SettingsProfile = 'resume'): Promise<void> {
  try {
    const expected = EXPECTED_SETTINGS[profile];
    if (!expected) throw new Error(READ_FAILED);
    const actual = new Map((await readProtectedRows(tx, { kind: 'fingerprint', query: 'settings' })).map((r) => [text(r, 'name'), text(r, 'setting')]));
    for (const [name, value] of Object.entries(expected)) {
      if (actual.get(name) !== value) throw new Error(READ_FAILED);
    }
  } catch {
    throw new Error('protected settings proof failed');
  }
}

const liveColumnRows = (rows: RawRow[]): LiveColumnRow[] =>
  rows.map((r) => ({
    relname: text(r, 'relname'), attnum: int(r, 'attnum'), attname: text(r, 'attname'), formatType: text(r, 'format_type'), notNull: bool(r, 'not_null'),
    hasDefault: bool(r, 'has_default'), defaultExpr: optText(r, 'default_expr'), generated: text(r, 'generated'), identity: text(r, 'identity'),
    collation: optText(r, 'collation'), typtype: text(r, 'typtype'), typnsp: text(r, 'typnsp'), typname: text(r, 'typname'),
  }));
const domainRows = (rows: RawRow[]): LiveRelationDomainRow[] =>
  rows.map((r) => ({
    relname: text(r, 'relname'), relkind: text(r, 'relkind'), persistence: text(r, 'persistence'), isPartition: bool(r, 'is_partition'), hasSubclass: bool(r, 'has_subclass'),
    inheritanceRows: int(r, 'inheritance_rows'), rowSecurity: bool(r, 'row_security'), forceRowSecurity: bool(r, 'force_row_security'), hasRules: bool(r, 'has_rules'),
    ownerIsCurrentUser: bool(r, 'owner_is_current_user'), policies: int(r, 'policies'),
  }));

// T6: the own temp schema is empty (no shadowing relation/type can exist), no relation in `public` is outside the contract,
// every protected relation is an ordinary table, and the live column set equals the type contract exactly.
export async function proveDomainOnTransaction(tx: ProtectedTx): Promise<void> {
  try {
    const temp = (await readProtectedRows(tx, { kind: 'fingerprint', query: 'ownTemp' }))[0];
    if (!temp || text(temp, 'temp_classes') !== '0' || text(temp, 'temp_types') !== '0') throw new Error(READ_FAILED);
    const extra = (await readProtectedRows(tx, { kind: 'fingerprint', query: 'extraRelations' }))[0];
    if (!extra || text(extra, 'extra_relations') !== '0') throw new Error(READ_FAILED);
    assertRelationDomainFacts(domainRows(await readProtectedRows(tx, { kind: 'fingerprint', query: 'domain' })));
    assertLiveTypeContract(liveColumnRows(await readProtectedRows(tx, { kind: 'fingerprint', query: 'columns' })));
  } catch {
    throw new Error('protected domain proof failed');
  }
}

export type ReadStateResult = Readonly<{ rows: StateRows | null; serverVersionNum: string; markerId: string; schemaDigest: string }>;

// ONE pass over the protected state (stream format 3): header, enum types, functions, then the 25 relations in raw-byte
// order. All metadata is read and validated against the contract BEFORE the first stream byte is produced. The same rows
// feed every sink; they are returned (in memory) only when `keepRows` is set, for the in-transaction verifier.
export async function readStateOnTransaction(
  tx: ProtectedTx,
  sinks: readonly DigestSink[],
  keepRows: boolean,
  options: Readonly<{ maxRelationBytes?: number }> = {},
): Promise<ReadStateResult> {
  try {
    const metadata = {
      marker: await readProtectedRows(tx, { kind: 'fingerprint', query: 'marker' }),
      enums: await readProtectedRows(tx, { kind: 'fingerprint', query: 'enums' }),
      functions: await readProtectedRows(tx, { kind: 'fingerprint', query: 'functions' }),
      columns: await readProtectedRows(tx, { kind: 'fingerprint', query: 'columns' }),
      domain: await readProtectedRows(tx, { kind: 'fingerprint', query: 'domain' }),
      primaryKeys: await readProtectedRows(tx, { kind: 'fingerprint', query: 'primaryKeys' }),
      constraints: await readProtectedRows(tx, { kind: 'fingerprint', query: 'constraints' }),
      indexes: await readProtectedRows(tx, { kind: 'fingerprint', query: 'indexes' }),
      triggers: await readProtectedRows(tx, { kind: 'fingerprint', query: 'triggers' }),
      riTriggers: await readProtectedRows(tx, { kind: 'fingerprint', query: 'riTriggers' }),
      comments: await readProtectedRows(tx, { kind: 'fingerprint', query: 'comments' }),
    };
    const live = liveColumnRows(metadata.columns);
    assertLiveTypeContract(live);
    const domain = domainRows(metadata.domain);
    assertRelationDomainFacts(domain);
    if (metadata.marker.length !== 1) throw new Error(READ_FAILED);
    const m = metadata.marker[0] as RawRow;
    const header: StateHeader = {
      target: 'mona_local_test@127.0.0.1:5432/mona_local_test',
      markerId: text(m, 'marker_id'),
      markerInstalledAt: text(m, 'installed_at'),
      serverVersionNum: text(m, 'server_version_num'),
      searchPath: text(m, 'search_path'),
      serverEncoding: text(m, 'server_encoding'),
      clientEncoding: text(m, 'client_encoding'),
    };
    const typeNames = new Map<string, string[]>();
    for (const r of metadata.enums) {
      const key = `${text(r, 'nspname')}\u0000${text(r, 'typname')}`;
      typeNames.set(key, [...(typeNames.get(key) ?? []), text(r, 'label')]);
    }
    const types: EnumTypeFacts[] = [...typeNames.entries()].map(([key, labels]) => {
      const [schema, name] = key.split('\u0000') as [string, string];
      return { schema, name, labels };
    });
    const functions: FunctionFacts[] = metadata.functions.map((r) => ({
      name: text(r, 'proname'), identityArgs: text(r, 'identity_args'), returnType: text(r, 'return_type'), language: text(r, 'language'),
      source: text(r, 'source'), config: optText(r, 'config') ?? '', securityDefiner: bool(r, 'security_definer'), volatility: text(r, 'volatility'),
      strict: bool(r, 'strict'), kind: text(r, 'kind'),
    }));

    const writer = new StateStreamWriter(sinks, options);
    writer.header(header);
    writer.types(types);
    writer.functions(functions);
    const kept = new Map<string, readonly (readonly CellText[])[]>();
    for (const relation of PROTECTED_RELATIONS) {
      const forRelation = (rows: RawRow[]) => rows.filter((r) => text(r, 'relname') === relation);
      const domainRow = forRelation(metadata.domain)[0] as RawRow;
      const facts: RelationFacts = {
        relation,
        columns: live.filter((c) => c.relname === relation).map((c) => ({ attnum: c.attnum, name: c.attname, formatType: c.formatType, notNull: c.notNull, defaultExpr: c.defaultExpr, collation: c.collation })),
        pk: forRelation(metadata.primaryKeys).sort((a, b) => int(a, 'ord') - int(b, 'ord')).map((r) => int(r, 'attnum')),
        constraints: forRelation(metadata.constraints).map((r) => ({ name: text(r, 'conname'), type: text(r, 'contype'), validated: bool(r, 'validated'), definition: text(r, 'definition') })),
        indexes: forRelation(metadata.indexes).map((r) => ({ name: text(r, 'indexname'), definition: text(r, 'definition'), valid: bool(r, 'valid'), ready: bool(r, 'ready') })),
        triggers: forRelation(metadata.triggers).map((r) => ({ name: text(r, 'tgname'), enabled: text(r, 'enabled'), definition: text(r, 'definition') })),
        riTriggers: forRelation(metadata.riTriggers).map((r) => ({ constraint: text(r, 'conname'), type: int(r, 'tgtype'), func: text(r, 'func'), enabled: text(r, 'enabled') })),
        rowSecurity: bool(domainRow, 'row_security'),
        forceRowSecurity: bool(domainRow, 'force_row_security'),
        policies: int(domainRow, 'policies'),
        rules: bool(domainRow, 'has_rules') ? 1 : 0,
        inheritanceChildren: int(domainRow, 'inheritance_rows'),
        comment: optText(forRelation(metadata.comments)[0] as RawRow, 'comment'),
      };
      const columnCount = TYPE_CONTRACT_V3.filter((c) => c.relation === relation).length;
      const rows: CellText[][] = (await readProtectedRows(tx, { kind: 'relationRows', relation })).map((r) => {
        const cells: CellText[] = [];
        for (let i = 1; i <= columnCount; i += 1) cells.push(optText(r, `c${i}`));
        return cells;
      });
      writer.relation(facts, rows);
      if (keepRows) kept.set(relation, rows);
    }
    const schemaDigest = writer.finish();
    return { rows: keepRows ? kept : null, serverVersionNum: header.serverVersionNum, markerId: header.markerId, schemaDigest };
  } catch {
    throw new Error(READ_FAILED);
  }
}
