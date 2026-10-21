import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { uniqueViolation } from '../payments/prisma-unique-violation.js';

// WAREHOUSE-MVP: manual stock adjustment. physical = previous physical + delta
// (never "set"); reserved is NEVER changed. One StockMovement (type ADJUSTMENT)
// and one audit row (real branch and actor) commit atomically with the balance
// change, under a Serializable transaction and the Inventory row lock.
//
// Authorization: INVENTORY_MANAGE at the body branch (hasPermissionAtLocation).
// inventory.routes.ts enforces it before this runs; adjustStock re-checks it so
// the service is never callable around the route gate.

export const ADJUSTMENT_REASONS = ['DAMAGED', 'LOST', 'LOAD_ERROR', 'SURPLUS', 'OTHER'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const ADJUSTMENT_MAX_ABS_DELTA = 100n;
export const ADJUSTMENT_OTHER_NOTE_MIN_LENGTH = 10;

export const stockAdjustmentSchema = z
  .object({
    variantId: z.uuid(),
    branchId: z.uuid(),
    // Signed integer as a JSON string — BigInt-safe, no decimals.
    delta: z.string().regex(/^[+-]?[0-9]{1,18}$/).transform((value) => BigInt(value)),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: z.string().max(500).optional(),
    idempotencyKey: z.string().trim().min(1).max(128),
  })
  .strict();

export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

type AdjustmentDatabase = Pick<PrismaClient, '$transaction'>;
type LockedInventory = { id: string; physical: bigint; reserved: bigint };

const concurrencyError = () =>
  new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');

// Transient classification (P2034 / SQLSTATE 40001 / 40P01 / TransactionWriteConflict)
// in every shape the driver stack really produces: Prisma code, meta.code, the
// adapter-pg driverAdapterError cause (originalCode / kind), a pg error carrying
// the SQLSTATE as `code`, an Error.cause chain, or the SQLSTATE in the message.
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01']);
const MAX_CAUSE_DEPTH = 4;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isTransientState = (value: unknown) => typeof value === 'string' && TRANSIENT_SQLSTATES.has(value);

function isTransient(error: unknown, depth = 0): boolean {
  if (!isRecord(error) || depth > MAX_CAUSE_DEPTH) return false;
  const meta = isRecord(error.meta) ? error.meta : {};
  const adapter = isRecord(meta.driverAdapterError) ? meta.driverAdapterError : {};
  const adapterCause = isRecord(adapter.cause) ? adapter.cause : {};
  const message = error instanceof Error ? error.message : '';
  return error.code === 'P2034'
    || isTransientState(error.code)
    || isTransientState(meta.code)
    || isTransientState(adapterCause.originalCode)
    || isTransientState(adapterCause.code)
    || adapterCause.kind === 'TransactionWriteConflict'
    || /(?<![0-9A-Za-z])(40001|40P01)(?![0-9A-Za-z])/.test(message)
    || message.includes('TransactionWriteConflict')
    || isTransient(error.cause, depth + 1);
}

// P2002 is retryable ONLY for the two races this flow expects: the first
// Inventory row of a (variant, branch) created concurrently, and the same
// (userId, idempotencyKey) inserted concurrently. Any other unique violation
// (or one naming nothing) is not ours and propagates to the normal handler.
const sameFields = (fields: string[] | null, expected: string[]) =>
  fields !== null && fields.length === expected.length && expected.every((field) => fields.includes(field));

function isExpectedUniqueRace(error: unknown) {
  const violation = uniqueViolation(error);
  if (violation === null) return false;
  const inventory = (violation.modelName === null || violation.modelName === 'Inventory')
    && (violation.name === 'Inventory_variantId_branchId_key' || sameFields(violation.fields, ['variantId', 'branchId']));
  const idempotency = (violation.modelName === null || violation.modelName === 'StockMovement')
    && (violation.name === 'StockMovement_userId_idempotencyKey_key' || sameFields(violation.fields, ['userId', 'idempotencyKey']));
  return inventory || idempotency;
}

// Exported so the opt-in PostgreSQL suite can classify REAL driver errors with the same rule.
export const isRetryable = (error: unknown) => isTransient(error) || isExpectedUniqueRace(error);

const normalizeNote = (note: string | undefined) => {
  const trimmed = note?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
};

// Business rules are checked after the permission gate, so an unauthorized
// caller always gets 403 first.
function assertAdjustmentRules(input: StockAdjustmentInput, note: string | null) {
  if (input.delta === 0n) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La cantidad del ajuste no puede ser cero.');
  }
  const magnitude = input.delta < 0n ? -input.delta : input.delta;
  if (magnitude > ADJUSTMENT_MAX_ABS_DELTA) {
    throw new AppError(400, 'ADJUSTMENT_LIMIT_EXCEEDED', 'El ajuste no puede superar 100 unidades por operación.');
  }
  const negativeOnly = input.reason === 'DAMAGED' || input.reason === 'LOST';
  if (negativeOnly && input.delta > 0n) {
    throw new AppError(400, 'ADJUSTMENT_REASON_SIGN_MISMATCH', 'Este motivo solo admite un ajuste negativo (salida de stock).');
  }
  if (input.reason === 'SURPLUS' && input.delta < 0n) {
    throw new AppError(400, 'ADJUSTMENT_REASON_SIGN_MISMATCH', 'Este motivo solo admite un ajuste positivo (ingreso de stock).');
  }
  if (input.reason === 'OTHER' && (note?.length ?? 0) < ADJUSTMENT_OTHER_NOTE_MIN_LENGTH) {
    throw new AppError(400, 'ADJUSTMENT_NOTE_REQUIRED', 'El motivo "Otro" requiere una nota de al menos 10 caracteres.');
  }
}

export function createInventoryAdjustmentService(database: AdjustmentDatabase) {
  async function adjustInTransaction(userId: string, input: StockAdjustmentInput, note: string | null) {
    return database.$transaction(async (tx) => {
      // 1. Replay: (userId, idempotencyKey) is unique; a replay never mutates stock.
      const existing = await tx.stockMovement.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
        select: {
          id: true, type: true, quantityDelta: true, reason: true, note: true, idempotencyKey: true, branchId: true,
          inventory: { select: { id: true, variantId: true, branchId: true, physical: true, reserved: true } },
        },
      });
      if (existing) {
        const samePayload = existing.type === 'ADJUSTMENT'
          && existing.inventory.variantId === input.variantId
          && existing.branchId === input.branchId
          && existing.quantityDelta === input.delta
          && existing.reason === input.reason
          && (existing.note ?? null) === note;
        if (!samePayload) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro ajuste.');
        }
        const { inventory, ...movement } = existing;
        return {
          movement,
          inventory: { ...inventory, available: inventory.physical - inventory.reserved },
          replayed: true,
        };
      }

      // 2. Variant and location.
      const [variant, branch, location] = await Promise.all([
        tx.productVariant.findUnique({ where: { id: input.variantId }, select: { id: true, sku: true, isActive: true } }),
        tx.branch.findUnique({ where: { id: input.branchId }, select: { id: true } }),
        // Location.id == Branch.id (Phase 1A mapping).
        tx.location.findUnique({ where: { id: input.branchId }, select: { isActive: true } }),
      ]);
      if (!variant) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante.');
      if (!variant.isActive) throw new AppError(409, 'VARIANT_INACTIVE', 'La variante está inactiva y no admite ajustes de stock.');
      if (!branch || !location?.isActive) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sucursal.');

      // 3. A positive adjustment may create the Inventory row (0/0); a negative
      //    one never does. A lost first-insert race (P2002) retries the whole call.
      if (input.delta > 0n) {
        await tx.inventory.upsert({
          where: { variantId_branchId: { variantId: input.variantId, branchId: input.branchId } },
          create: { variantId: input.variantId, branchId: input.branchId, physical: 0n, reserved: 0n },
          update: {},
        });
      }

      // 4. Lock the row, then read the balance (never before the lock).
      const [before] = await tx.$queryRaw<LockedInventory[]>`
        SELECT id, physical, reserved FROM "Inventory"
        WHERE "variantId" = ${input.variantId} AND "branchId" = ${input.branchId}
        FOR UPDATE
      `;
      const beforePhysical = before?.physical ?? 0n;
      const beforeReserved = before?.reserved ?? 0n;
      const afterPhysical = beforePhysical + input.delta;
      if (!before || afterPhysical < 0n) {
        throw new AppError(409, 'NEGATIVE_STOCK', 'El ajuste dejaría el stock físico en negativo.');
      }
      if (afterPhysical < beforeReserved) {
        throw new AppError(409, 'STOCK_BELOW_RESERVED', 'El ajuste dejaría el stock físico por debajo de lo reservado.');
      }

      // 5. Only physical changes; reserved is never written.
      const inventory = await tx.inventory.update({
        where: { id: before.id },
        data: { physical: afterPhysical },
        select: { id: true, variantId: true, branchId: true, physical: true, reserved: true },
      });
      const movement = await tx.stockMovement.create({
        data: {
          inventoryId: inventory.id,
          type: 'ADJUSTMENT',
          quantityDelta: input.delta,
          saleId: null,
          userId,
          branchId: input.branchId,
          reason: input.reason,
          note,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true, type: true, quantityDelta: true, reason: true, note: true, idempotencyKey: true, branchId: true },
      });
      await createAuditLog(tx, {
        userId,
        branchId: input.branchId,
        action: 'INVENTORY_MANUAL_ADJUSTMENT',
        entityType: 'Inventory',
        entityId: inventory.id,
        before: { physical: beforePhysical, reserved: beforeReserved, available: beforePhysical - beforeReserved },
        after: {
          physical: inventory.physical,
          reserved: inventory.reserved,
          available: inventory.physical - inventory.reserved,
          delta: input.delta,
          reason: input.reason,
          note,
          variantId: input.variantId,
          sku: variant.sku,
          movementId: movement.id,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return {
        movement,
        inventory: { ...inventory, available: inventory.physical - inventory.reserved },
        replayed: false,
      };
    }, { isolationLevel: 'Serializable', timeout: 30000 });
  }

  async function adjustStock(auth: Express.AuthContext, input: StockAdjustmentInput) {
    if (!hasPermissionAtLocation(auth, PRODUCTION_PERMISSIONS.INVENTORY_MANAGE, input.branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para esta operación.');
    }
    const note = normalizeNote(input.note);
    assertAdjustmentRules(input, note);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await adjustInTransaction(auth.userId, input, note);
      } catch (error) {
        if (!isRetryable(error)) throw error;
        if (attempt === 3) throw concurrencyError();
      }
    }
    throw concurrencyError();
  }

  return { adjustStock };
}
