// R3-A4.3 S-REF: T-F, the refund of an ExternalCollection received outside
// the POS (POST /api/v1/external-collections/:id/refund), and the branch
// listing of collections (GET /api/v1/external-collections).
//
// T-F is ONE READ COMMITTED transaction (timeout 30 s) with no contention
// handling of its own: no NOWAIT, no serialization-failure reprocessing and no
// attempt-based lock. Order:
//   1. lock the collection of the URL (SELECT … FOR UPDATE; 404 if absent);
//   2. permission ON THE LOCKED ec.branchId (actsAsSupervisorAtLocation, the
//      refactored SALE_CANCEL_PENDING supervisor policy; nothing about the
//      collection is acted on before this);
//   3. state / idempotency: APPLIED -> 409 ALREADY_APPLIED; REFUNDED with the
//      SAME canonical reference + date + reason -> 200 replay with zero write
//      and zero audit; REFUNDED with anything else -> 409 ALREADY_REFUNDED;
//      UNAPPLIED with a claim -> 409 CLAIMED;
//   4. the single server `resolvedAt`; a future externalRefundedAt is 400
//      BEFORE the UPDATE (the DB CHECKs and the F6 trigger must never be the
//      thing that refuses an otherwise well-formed request);
//   5. UPDATE UNAPPLIED -> REFUNDED with resolvedById/at, the RAW TRIMMED
//      refundReference, the trimmed resolutionNote and externalRefundedAt;
//   6. AuditLog EXTERNAL_COLLECTION_REFUNDED with before/after snapshots, in
//      the SAME transaction: a failing audit rolls the whole refund back.
//
// The amount is NEVER an input and NEVER recomputed: it is exactly the locked
// row's amount (BigInt centavos end-to-end). There is no partial refund, and
// no cash, stock, sale or attempt row is ever written here.
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createAuditLog } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import { actsAsSupervisorAtLocation, hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { normalizeReferenceKey } from './checkout-canonical.js';
import type {
  ExternalCollectionListQuery,
  ExternalCollectionRefundRequest,
} from './dto/external-collection-refund.dto.js';

const REFUND_TIMEOUT_MS = 30_000;

type RequestLike = { auth?: Express.AuthContext };

type LockedCollection = {
  id: string;
  branchId: string;
  method: string;
  amount: bigint;
  reference: string;
  referenceKey: string;
  institution: string | null;
  institutionOther: string | null;
  status: string;
  originSaleId: string | null;
  originAttemptId: string | null;
  cashSessionId: string | null;
  recordedById: string;
  recordedAt: Date;
  resolvedById: string | null;
  resolvedAt: Date | null;
  refundReference: string | null;
  resolutionNote: string | null;
  externalRefundedAt: Date | null;
  claimAttemptId: string | null;
};

// The public projection: it never leaks the internal claimAttemptId.
export type ExternalCollectionView = Omit<LockedCollection, 'claimAttemptId'>;

export type ExternalCollectionRefundResult = {
  replayed: boolean;
  collection: ExternalCollectionView;
};

export type ExternalCollectionListResult = {
  items: ExternalCollectionView[];
};

export type ExternalCollectionsService = {
  refund: (
    req: RequestLike,
    externalCollectionId: string,
    request: ExternalCollectionRefundRequest,
  ) => Promise<ExternalCollectionRefundResult>;
  list: (req: RequestLike, query: ExternalCollectionListQuery) => Promise<ExternalCollectionListResult>;
};

function notFound() {
  return new AppError(404, 'NOT_FOUND', 'No se encontró el cobro externo.');
}

function forbidden() {
  return new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
}

function claimed() {
  return new AppError(
    409,
    'EXTERNAL_COLLECTION_CLAIMED',
    'El cobro registrado está reservado por un intento de cobro abierto.',
  );
}

function alreadyApplied() {
  return new AppError(
    409,
    'EXTERNAL_COLLECTION_ALREADY_APPLIED',
    'El cobro registrado ya fue aplicado a un cobro y no puede devolverse.',
  );
}

function alreadyRefunded() {
  return new AppError(
    409,
    'EXTERNAL_COLLECTION_ALREADY_REFUNDED',
    'El cobro registrado ya fue devuelto con otro contenido; la devolución es distinta.',
  );
}

function refundDateInFuture() {
  return new AppError(
    400,
    'EXTERNAL_REFUND_DATE_IN_FUTURE',
    'La fecha de la devolución no puede ser futura.',
  );
}

// Defensive: an impossible persisted status must fail closed, never 500 in the
// database as an unmapped check_violation.
function inconsistentState(status: string) {
  return new AppError(
    500,
    'EXTERNAL_COLLECTION_STATE_INCONSISTENT',
    `El cobro externo tiene un estado inesperado (${status}).`,
  );
}

function toView(row: LockedCollection): ExternalCollectionView {
  return {
    id: row.id,
    branchId: row.branchId,
    method: row.method,
    amount: row.amount,
    reference: row.reference,
    referenceKey: row.referenceKey,
    institution: row.institution,
    institutionOther: row.institutionOther,
    status: row.status,
    originSaleId: row.originSaleId,
    originAttemptId: row.originAttemptId,
    cashSessionId: row.cashSessionId,
    recordedById: row.recordedById,
    recordedAt: row.recordedAt,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt,
    refundReference: row.refundReference,
    resolutionNote: row.resolutionNote,
    externalRefundedAt: row.externalRefundedAt,
  };
}

// The audit snapshot: the identity, the resolution and the financial/control
// context (S-REF.1 A4). It never carries credentials, and the amount is passed
// as a BigInt so createAuditLog serialises it as a JSON-safe decimal string —
// never as a JavaScript number.
function snapshot(row: LockedCollection) {
  return {
    id: row.id,
    status: row.status,
    branchId: row.branchId,
    method: row.method,
    amount: row.amount,
    reference: row.reference,
    referenceKey: row.referenceKey,
    originSaleId: row.originSaleId,
    originAttemptId: row.originAttemptId,
    cashSessionId: row.cashSessionId,
    claimAttemptId: row.claimAttemptId,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt,
    refundReference: row.refundReference,
    resolutionNote: row.resolutionNote,
    externalRefundedAt: row.externalRefundedAt,
  };
}

// The replay identity is exactly the canonical refundReference + the exact
// externalRefundedAt instant + the trimmed reason. The ACTOR is deliberately
// NOT part of it: any authorized supervisor may replay the same refund.
function isIdenticalReplay(row: LockedCollection, request: ExternalCollectionRefundRequest) {
  return row.externalRefundedAt !== null
    && normalizeReferenceKey(row.refundReference ?? '') === normalizeReferenceKey(request.refundReference)
    && row.externalRefundedAt.getTime() === request.externalRefundedAt.getTime()
    && row.resolutionNote === request.reason;
}

export function createExternalCollectionsService(
  database: PrismaClient,
  options: { now?: () => Date } = {},
): ExternalCollectionsService {
  const now = options.now ?? (() => new Date());

  async function refund(
    req: RequestLike,
    externalCollectionId: string,
    request: ExternalCollectionRefundRequest,
  ): Promise<ExternalCollectionRefundResult> {
    return database.$transaction(async (tx) => {
      // 1. Lock the collection by primary key. Plain FOR UPDATE: T-F has no
      // contention signal of its own (no NOWAIT, no attempt-based locking).
      const [row] = await tx.$queryRaw<LockedCollection[]>`
        SELECT "id", "branchId", "method", "amount", "reference", "referenceKey",
               "institution", "institutionOther", "status", "originSaleId",
               "originAttemptId", "cashSessionId", "recordedById", "recordedAt",
               "resolvedById", "resolvedAt", "refundReference", "resolutionNote",
               "externalRefundedAt", "claimAttemptId"
        FROM "ExternalCollection"
        WHERE "id" = ${externalCollectionId}
        FOR UPDATE
      `;
      if (!row) throw notFound();

      // 2. Authorization on the locked branch. SALE_CANCEL_PENDING acts through
      // the supervisor policy: OWNER and a COMPANY ADMIN qualify; a LOCATION
      // ADMIN, a CASHIER and a supervisor assignment of another branch do not.
      if (!req.auth || !actsAsSupervisorAtLocation(
        req.auth,
        [PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING],
        row.branchId,
      )) throw forbidden();

      // 3. State and idempotency, in this exact order.
      if (row.status === 'APPLIED') throw alreadyApplied();
      if (row.status === 'REFUNDED') {
        if (!isIdenticalReplay(row, request)) throw alreadyRefunded();
        return { replayed: true, collection: toView(row) };
      }
      if (row.status !== 'UNAPPLIED') throw inconsistentState(row.status);
      if (row.claimAttemptId !== null) throw claimed();

      // 4. ONE server time. A future external date is a boundary error, never a
      // chk_ec_refund_fields violation discovered inside the UPDATE.
      const resolvedAt = now();
      if (request.externalRefundedAt.getTime() > resolvedAt.getTime()) throw refundDateInFuture();

      // 5. The single write. The raw trimmed reference is persisted; the amount
      // is untouched (there is no partial refund).
      const updated = await tx.externalCollection.update({
        where: { id: row.id },
        data: {
          status: 'REFUNDED',
          resolvedById: req.auth.userId,
          resolvedAt,
          refundReference: request.refundReference,
          resolutionNote: request.reason,
          externalRefundedAt: request.externalRefundedAt,
        },
      });

      // 6. Audit in the same transaction: a failing audit rolls everything back.
      await createAuditLog(tx, {
        userId: req.auth.userId,
        branchId: row.branchId,
        action: 'EXTERNAL_COLLECTION_REFUNDED',
        entityType: 'ExternalCollection',
        entityId: row.id,
        before: snapshot(row),
        after: snapshot(updated as LockedCollection),
      });

      return { replayed: false, collection: toView(updated as LockedCollection) };
    }, { isolationLevel: 'ReadCommitted', timeout: REFUND_TIMEOUT_MS });
  }

  // A supervisor at the branch sees the whole branch; a SALE_CHARGE holder
  // without supervisor authority sees only the rows it recorded; nobody else
  // reads anything. Plain read, no lock, no write.
  function assertCanList(req: RequestLike, branchId: string) {
    const auth = req.auth;
    const supervisor = Boolean(auth && actsAsSupervisorAtLocation(
      auth,
      [PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING],
      branchId,
    ));
    const canCharge = Boolean(auth && hasPermissionAtLocation(
      auth,
      PRODUCTION_PERMISSIONS.SALE_CHARGE,
      branchId,
    ));
    if (!supervisor && !canCharge) throw forbidden();
    return { supervisor };
  }

  async function list(
    req: RequestLike,
    query: ExternalCollectionListQuery,
  ): Promise<ExternalCollectionListResult> {
    const { supervisor } = assertCanList(req, query.branchId);
    return database.$transaction(async (tx) => {
      const items = await tx.externalCollection.findMany({
        where: {
          branchId: query.branchId,
          ...(query.status === null ? {} : { status: query.status }),
          ...(supervisor ? {} : { recordedById: req.auth!.userId }),
        },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
      });
      return { items: items.map((item) => toView(item as unknown as LockedCollection)) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  return { refund, list };
}
