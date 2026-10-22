// R3-A4.3 S6: T-X, the close/declaration of a durable charge reservation
// (POST /sales/:saleId/checkout/reservations/:reserveKey/close).
//
// T-X is ONE READ COMMITTED transaction (timeout 30 s) with NO P2034 / 40001 /
// 40P01 retries: the contract assigns none to T-X. Lock order:
//   Sale (FOR UPDATE NOWAIT) -> CheckoutAttempt (reserveKey + saleId)
//   -> ExternalCollection of the attempt's COLLECTION tenders (id ASC).
// The parallel lock failure PostgreSQL raises (55P03) is the ONLY contention
// signal and becomes 409 CHECKOUT_RESERVATION_BUSY.
//
// WRITE ORDER of a FRESH close (schema triggers F4/F6; owner decision
// 2026-10-16). Replays (CONFIRMED, or an identical declared attempt) write
// nothing at all.
//   0. the visibility bump: UPDATE "Sale" SET "updatedAt" = now();
//   1. a RESERVED attempt moves to ABANDONED with declaredAt still NULL — F4
//      refuses a declaration on any attempt that is not already terminal;
//   2. Phase A: the ExternalCollection of EVERY CHARGED row is inserted first
//      (UNAPPLIED, on the attempt's cashSessionId), in canonical plan order;
//   3. Phase B: only then is every declaration inserted (one per plan tender,
//      canonical order), each CHARGED row reusing its Phase A collection —
//      S6.3 (S6-B05): no declaration exists before all CHARGED collections do;
//   4. declaredAt is fixed;
//   5. ONLY THEN are the COLLECTION claims released — F6 refuses the release
//      until the attempt is terminal AND declared ("Claim release requires a
//      completed declaration");
//   6. every audit row, after the last business write, same transaction.
// The owner-authorized DOCUMENT 4 (declarations -> declaredAt -> release ->
// audit) supersedes the older in-repo wording that released the claim before
// declaredAt.
//
// S6 touches NO Inventory, StockMovement, StockReservation, CashSession or
// CashMovement: a RETURNED cash amount never entered the registered drawer, so
// it never leaves it. Stock recovery is S7; the guards are S8.
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { actsAsSupervisorAtLocation, hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { CHECKOUT_METHODS } from './checkout-canonical.js';
import { loadReservationView, readCheckoutResult, type ReservationView } from './checkout-attempt-view.js';
import type { CheckoutResult } from './checkout.service.js';
import { isExternalReferenceCollision } from './prisma-unique-violation.js';
import type { CheckoutCloseRequest, CheckoutDeclarationRow } from './dto/checkout-close.dto.js';

const CLOSE_TIMEOUT_MS = 30_000;

type RequestLike = { auth?: Express.AuthContext };
type Tx = Prisma.TransactionClient;

type LockedSale = {
  id: string; branchId: string; status: string; pricingMode: string; priceMode: string; pricingModel: string;
};
// The attempt columns the close needs: the read model (loadReservationView),
// the sealed plan of the CHARGED rows (expectedBalanceAmount) and the
// persisted declaration semantics (declaredById/declaredAt/abandon*).
type LockedAttempt = {
  id: string; saleId: string; branchId: string; reserveKey: string; operationKey: string;
  planSealed: boolean; status: string; startedById: string; startedAt: Date;
  cashSessionId: string; balanceMethod: string; expectedTotal: bigint; expectedBalanceAmount: bigint; tenderCount: number;
  fullPriceCash: bigint; fullPriceTransfer: bigint | null; fullPriceDebit: bigint | null; fullPriceCredit: bigint | null; fullPriceQr: bigint | null;
  confirmationHash: string | null; recoveryReason: string | null; recoveryEvidence: string | null;
  rejectionCode: string | null; rejectionDetails: unknown;
  abandonedById: string | null; abandonedAt: Date | null; abandonReason: string | null; abandonEvidence: string | null;
  declaredById: string | null; declaredAt: Date | null;
};
type PlanTender = { method: string; role: string; source: string; amount: bigint | null; externalCollectionId: string | null };
type CollectionRow = {
  id: string; method: string; amount: bigint; reference: string; referenceKey: string;
  institution: string | null; institutionOther: string | null; status: string; recordedById: string;
};

export type CheckoutCloseResult = {
  replayed: boolean;
  view: ReservationView;
  checkout: CheckoutResult | null;
};

// ---------------------------------------------------------------------------
// Errors. A defect is a 500; a correctable conflict is 409; a supervised
// declaration lacking evidence is 400.
// ---------------------------------------------------------------------------
const notFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la reserva de cobro.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const reservationBusy = () => new AppError(409, 'CHECKOUT_RESERVATION_BUSY', 'La reserva de cobro está en uso; vuelva a intentar.');
const alreadyRecorded = () => new AppError(409, 'CHECKOUT_DECLARATION_ALREADY_RECORDED', 'La reserva de cobro ya fue declarada con otro contenido.');
const declarationMismatch = () => new AppError(409, 'CHECKOUT_DECLARATION_MISMATCH', 'La declaración no coincide con el plan de cobro sellado.');
const amountMismatch = () => new AppError(409, 'CHECKOUT_DECLARATION_AMOUNT_MISMATCH', 'El importe declarado no coincide con el plan sellado.');
const evidenceRequired = () => new AppError(400, 'CHECKOUT_DECLARATION_EVIDENCE_REQUIRED', 'Una declaración supervisada requiere comprobante en cada renglón.');
const inconsistentState = (message: string) => new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', message);
const referenceAlreadyRecorded = () => new AppError(409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED', 'La referencia ya está registrada.');

const methodOrder = (method: string) => (CHECKOUT_METHODS as readonly string[]).indexOf(method);
const byMethod = (left: { method: string }, right: { method: string }) => methodOrder(left.method) - methodOrder(right.method);

// PostgreSQL raised the NOWAIT lock failure. Prisma surfaces a raw-query
// failure as P2010 with meta.code = SQLSTATE (55P03); the message is the safe
// fallback. No other error is ever converted.
export function isLockNotAvailable(error: unknown): boolean {
  const candidate = error as { code?: string; meta?: { code?: string } };
  if (candidate.code === '55P03' || candidate.meta?.code === '55P03') return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('55P03') || /could not obtain lock/i.test(message);
}

// A P2002 for one of the two partial EXTERNAL reference indexes is the SAME
// domain error as T-C's (409 EXTERNAL_REFERENCE_ALREADY_RECORDED). Detection is
// by the unique constraint only — meta.target or the adapter-pg 7.10 shape
// (R-1/R-2, prisma-unique-violation.ts, shared with T-C); any other P2002 is
// rethrown. Never a false positive.
export { isExternalReferenceCollision };

// The semantic content of a declaration, used ONLY for T-X idempotency (never
// for pricing). Server-generated ids and declaredAt are excluded on purpose.
type ContentRow = {
  method: string; tenderSource: string; outcome: string; returnedAmount: bigint | null; evidence: string | null;
  amount: bigint | null; reference: string | null; referenceKey: string | null;
  institution: string | null; institutionOther: string | null;
};
type Content = {
  declaredById: string;
  supervisor: { reason: string | null; evidence: string | null } | null;
  rows: ContentRow[];
};

const sameContent = (left: Content, right: Content): boolean => JSON.stringify(left, (_key, value) => (
  typeof value === 'bigint' ? value.toString(10) : value
)) === JSON.stringify(right, (_key, value) => (typeof value === 'bigint' ? value.toString(10) : value));

export function createCheckoutCloseService(
  database: PrismaClient,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  function assertCanCharge(req: RequestLike, branchId: string) {
    if (!req.auth || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_CHARGE, branchId)) throw forbidden();
  }

  async function lockSale(tx: Tx, saleId: string): Promise<LockedSale> {
    const [sale] = await tx.$queryRaw<LockedSale[]>`
      SELECT id, "branchId", status, "pricingMode", "priceMode", "pricingModel"
      FROM "Sale" WHERE id = ${saleId} FOR UPDATE NOWAIT
    `;
    if (!sale) throw notFound();
    return sale;
  }

  async function lockAttempt(tx: Tx, saleId: string, reserveKey: string): Promise<LockedAttempt | null> {
    const [attempt] = await tx.$queryRaw<LockedAttempt[]>`
      SELECT id, "saleId", "branchId", "reserveKey", "operationKey", "planSealed", status,
             "startedById", "startedAt", "cashSessionId", "balanceMethod", "expectedTotal",
             "expectedBalanceAmount", "tenderCount", "fullPriceCash", "fullPriceTransfer", "fullPriceDebit", "fullPriceCredit", "fullPriceQr",
             "confirmationHash", "recoveryReason", "recoveryEvidence", "rejectionCode", "rejectionDetails",
             "abandonedById", "abandonedAt", "abandonReason", "abandonEvidence", "declaredById", "declaredAt"
      FROM "CheckoutAttempt"
      WHERE "reserveKey" = ${reserveKey} AND "saleId" = ${saleId}
      FOR UPDATE
    `;
    return attempt ?? null;
  }

  // The attempt's own COLLECTION claims, locked in id order (no other
  // collection is touched by T-X; nothing here reads CashSession or stock).
  async function lockClaims(tx: Tx, attemptId: string): Promise<CollectionRow[]> {
    return tx.$queryRaw<CollectionRow[]>`
      SELECT id, method, amount, reference, "referenceKey", institution, "institutionOther", status, "recordedById"
      FROM "ExternalCollection"
      WHERE "claimAttemptId" = ${attemptId}
      ORDER BY id ASC
      FOR UPDATE
    `;
  }

  // The supervisor justification of a declared REJECTED attempt. No attempt
  // column may hold it (chk_attempt_status_fields keeps abandon* NULL on
  // REJECTED), so the ONE durable copy is the CHECKOUT_DECLARATION_RECORDED
  // audit row T-X wrote in the same transaction as declaredAt. It is resolved
  // only when unambiguous: exactly one such row for the attempt, by the
  // declaring actor, with string reason/evidence. Anything else is a defect.
  async function rejectedSupervisor(tx: Tx, attempt: LockedAttempt): Promise<{ reason: string; evidence: string }> {
    const rows = await tx.auditLog.findMany({
      where: { entityType: 'CheckoutAttempt', entityId: attempt.id, action: 'CHECKOUT_DECLARATION_RECORDED' },
    });
    const after = rows.length === 1 && rows[0]!.userId === attempt.declaredById ? rows[0]!.after : null;
    const supervisor = after !== null && typeof after === 'object' && !Array.isArray(after)
      ? (after as Record<string, unknown>).supervisor
      : null;
    const candidate = supervisor !== null && typeof supervisor === 'object' && !Array.isArray(supervisor)
      ? supervisor as Record<string, unknown>
      : null;
    if (!candidate || typeof candidate.reason !== 'string' || typeof candidate.evidence !== 'string') {
      throw inconsistentState('La declaración supervisada no conserva una justificación auditada única.');
    }
    return { reason: candidate.reason, evidence: candidate.evidence };
  }

  // Rebuild the persisted semantics of an already declared attempt from the
  // declaration rows, the CHARGED collections and the supervisor justification
  // (ABANDONED: its abandon* columns; REJECTED: its declaration audit row).
  async function persistedContent(tx: Tx, attempt: LockedAttempt): Promise<Content> {
    const rows = await tx.checkoutAttemptDeclaration.findMany({ where: { attemptId: attempt.id } });
    const collections = new Map<string, CollectionRow>();
    for (const row of rows) {
      if (row.outcome !== 'CHARGED' || row.externalCollectionId === null) continue;
      const collection = await tx.externalCollection.findUnique({ where: { id: row.externalCollectionId } });
      if (collection) collections.set(collection.id, collection as CollectionRow);
    }
    return {
      declaredById: attempt.declaredById ?? '',
      // An initiator close has no justification; a supervised one persists it.
      supervisor: attempt.declaredById === attempt.startedById
        ? null
        : attempt.status === 'REJECTED'
          ? await rejectedSupervisor(tx, attempt)
          : { reason: attempt.abandonReason, evidence: attempt.abandonEvidence },
      rows: rows.map((row): ContentRow => {
        const collection = row.externalCollectionId === null ? undefined : collections.get(row.externalCollectionId);
        return {
          method: row.method,
          tenderSource: row.tenderSource,
          outcome: row.outcome,
          returnedAmount: row.returnedAmount,
          evidence: row.evidence,
          amount: collection?.amount ?? null,
          reference: collection?.reference ?? null,
          referenceKey: collection?.referenceKey ?? null,
          institution: collection?.institution ?? null,
          institutionOther: collection?.institutionOther ?? null,
        };
      }).sort(byMethod),
    };
  }

  // The semantics the caller's request WOULD persist, in the same shape.
  function incomingContent(
    attempt: LockedAttempt,
    userId: string,
    request: CheckoutCloseRequest,
    tenderByMethod: Map<string, PlanTender>,
  ): Content {
    const isInitiator = attempt.startedById === userId;
    return {
      declaredById: userId,
      supervisor: isInitiator
        ? null
        : { reason: request.supervisor?.reason ?? null, evidence: request.supervisor?.evidence ?? null },
      rows: request.declarations.map((row): ContentRow => ({
        method: row.method,
        tenderSource: tenderByMethod.get(row.method)?.source ?? '',
        outcome: row.outcome,
        returnedAmount: row.returnedAmount,
        evidence: row.evidence,
        amount: row.outcome === 'CHARGED' ? row.amount : null,
        reference: row.outcome === 'CHARGED' ? row.reference : null,
        referenceKey: row.outcome === 'CHARGED' ? row.referenceKey : null,
        institution: row.outcome === 'CHARGED' ? row.institution : null,
        institutionOther: row.outcome === 'CHARGED' ? row.institutionOther : null,
      })).sort(byMethod),
    };
  }

  // Structural validation of a FRESH close against the sealed plan. The
  // declaration must be exactly one row per sealed tender; a COLLECTION method
  // is never CHARGED (C2); a CHARGED amount is exactly the sealed amount.
  function validateAgainstPlan(
    attempt: LockedAttempt,
    userId: string,
    request: CheckoutCloseRequest,
    tenderByMethod: Map<string, PlanTender>,
    isInitiator: boolean,
  ): void {
    if (request.declarations.length !== tenderByMethod.size) throw declarationMismatch();
    const seen = new Set<string>();
    for (const row of request.declarations) {
      const tender = tenderByMethod.get(row.method);
      if (!tender || seen.has(row.method)) throw declarationMismatch();
      seen.add(row.method);
      if (tender.method === 'CASH') {
        if (tender.source !== 'NEW' || row.outcome === 'CHARGED') throw declarationMismatch();
      } else if (tender.source === 'COLLECTION' && row.outcome === 'CHARGED') {
        // A COLLECTION (already registered) tender is declared NONE only.
        throw declarationMismatch();
      } else if (row.outcome === 'CHARGED') {
        const sealed = tender.role === 'BALANCE' ? attempt.expectedBalanceAmount : (tender.amount ?? null);
        if (sealed === null || row.amount !== sealed) throw amountMismatch();
      }
      // F4: a non-initiator needs evidence on EVERY row.
      if (!isInitiator && row.evidence === null) throw evidenceRequired();
    }
  }

  async function closeOnce(
    req: RequestLike,
    saleId: string,
    reserveKey: string,
    request: CheckoutCloseRequest,
  ): Promise<CheckoutCloseResult> {
    return database.$transaction(async (tx): Promise<CheckoutCloseResult> => {
      // 1. Lock the sale of the URL (404), then the attempt of (reserveKey, saleId).
      const sale = await lockSale(tx, saleId);
      const attempt = await lockAttempt(tx, saleId, reserveKey);
      if (!attempt || attempt.branchId !== sale.branchId) throw notFound();

      // 2. Permissions on the persisted sale.branchId: the initiator charges on
      //    their own; anyone else must be a supervisor at that branch and leave
      //    a justification.
      const userId = req.auth!.userId;
      const isInitiator = attempt.startedById === userId;
      let supervisorReason: string | null = null;
      let supervisorEvidence: string | null = null;
      if (isInitiator) {
        assertCanCharge(req, sale.branchId);
      } else {
        if (!request.supervisor || !req.auth || !actsAsSupervisorAtLocation(
          req.auth,
          [PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING],
          sale.branchId,
        )) throw forbidden();
        supervisorReason = request.supervisor.reason;
        supervisorEvidence = request.supervisor.evidence;
      }

      // 3. The sealed plan is the only source of the declaration shape.
      const tenders = await tx.checkoutAttemptTender.findMany({ where: { attemptId: attempt.id } });
      const tenderByMethod = new Map(tenders.map((tender): [string, PlanTender] => [tender.method, tender]));

      // 4. CONFIRMED is immutable: replay its committed checkout, no write.
      if (attempt.status === 'CONFIRMED') {
        return {
          replayed: true,
          view: await loadReservationView(tx, attempt, now()),
          checkout: await readCheckoutResult(tx, attempt),
        };
      }

      // 5. Already declared: an identical replay (same actor + same content) is
      //    200 with ZERO writes; anything else is a 409.
      if (attempt.declaredAt !== null) {
        if (attempt.declaredById !== userId) throw alreadyRecorded();
        if (!sameContent(await persistedContent(tx, attempt), incomingContent(attempt, userId, request, tenderByMethod))) {
          throw alreadyRecorded();
        }
        return { replayed: true, view: await loadReservationView(tx, attempt, now()), checkout: null };
      }

      // 6. A fresh close: validate the declaration against the sealed plan
      //    before any write, then RESERVED -> ABANDONED, or an undeclared REJECTED.
      validateAgainstPlan(attempt, userId, request, tenderByMethod, isInitiator);
      if (attempt.status !== 'RESERVED' && attempt.status !== 'REJECTED') {
        throw inconsistentState('La reserva de cobro no admite una declaración en su estado actual.');
      }
      // Lock the collections the attempt holds as COLLECTION tenders (id ASC),
      // the third and last lock of T-X: no CashSession, StockReservation or
      // Inventory lock exists in S6.
      await lockClaims(tx, attempt.id);

      // 6b. R-2: an external reference this close would record CHARGED and
      //     that is ALREADY recorded on the branch is the same 409 as T-C's
      //     step-5 pre-check, before the first write. A plain read (no lock,
      //     so the lock order above is unchanged), mirroring the two partial
      //     unique indexes. Only a fast path: a peer can still commit the
      //     reference after this read, and the P2002 of the index stays the
      //     final authority (close()).
      for (const row of request.declarations) {
        if (row.outcome !== 'CHARGED' || (row.method !== 'TRANSFER' && row.method !== 'CARD_DEBIT' && row.method !== 'CARD_CREDIT' && row.method !== 'QR')) continue;
        const recorded = await tx.externalCollection.findFirst({
          where: row.method === 'TRANSFER'
            ? { branchId: sale.branchId, method: 'TRANSFER', institution: row.institution, referenceKey: row.referenceKey! }
            : { branchId: sale.branchId, method: row.method, referenceKey: row.referenceKey! },
          select: { id: true },
        });
        if (recorded) throw referenceAlreadyRecorded();
      }

      // 7. Visibility rule: the first write of a FRESH close, on the sale locked
      //    in step 1. No replay (steps 4–5) ever reaches it.
      await tx.$executeRaw`UPDATE "Sale" SET "updatedAt" = now() WHERE id = ${sale.id}`;

      // 8. Business writes, in DOCUMENT 4 order. Every audit row is emitted only
      //    in step 9, after the last business write; what it needs is kept here.
      const audits: Parameters<typeof createAuditLog>[1][] = [];
      const audit = (entry: Omit<Parameters<typeof createAuditLog>[1], 'userId' | 'branchId'>) => {
        audits.push({ userId, branchId: sale.branchId, ...entry });
      };
      const supervisor = isInitiator ? null : { reason: supervisorReason, evidence: supervisorEvidence };
      if (attempt.status === 'RESERVED') {
        // 8a. F4 requires the attempt to be terminal before any declaration
        //     exists; declaredAt stays NULL here and is fixed in 8d.
        await tx.checkoutAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'ABANDONED',
            abandonedById: userId,
            abandonedAt: now(),
            ...(isInitiator ? {} : { abandonReason: supervisorReason, abandonEvidence: supervisorEvidence }),
          },
        });
        audit({
          action: 'CHECKOUT_RESERVATION_ABANDONED',
          entityType: 'CheckoutAttempt', entityId: attempt.id,
          before: { status: 'RESERVED' },
          after: { status: 'ABANDONED', abandonReason: supervisorReason, abandonEvidence: supervisorEvidence, declaredAt: null },
        });
      }

      // 8b/8c. TWO canonical-order phases (S6.3, fixing S6-B05): Phase 8b
      //     inserts the ExternalCollection of EVERY CHARGED row first
      //     (UNAPPLIED, bound to the attempt/sale/branch/method/actor and to
      //     the ATTEMPT's cash session — never the request's); Phase 8c then
      //     inserts every declaration, each CHARGED row reusing the collection
      //     Phase 8b created for it. No declaration ever exists before all
      //     CHARGED collections do; both phases walk the plan in canonical
      //     order (no new ordering is invented).
      const ordered = [...tenders].sort(byMethod);
      const requestByMethod = new Map(request.declarations.map((row): [string, CheckoutDeclarationRow] => [row.method, row]));
      const collectionAudits: typeof audits = [];
      const returnedAudits: typeof audits = [];
      // Phase 8b: all CHARGED collections, in canonical plan order.
      const collectionIdByMethod = new Map<string, string>();
      for (const tender of ordered) {
        const row = requestByMethod.get(tender.method)!;
        if (row.outcome !== 'CHARGED') continue;
        const sealed = tender.role === 'BALANCE' ? attempt.expectedBalanceAmount : tender.amount!;
        const collection = await tx.externalCollection.create({
          data: {
            branchId: sale.branchId,
            method: tender.method,
            amount: sealed,
            reference: row.reference!,
            referenceKey: row.referenceKey!,
            institution: tender.method === 'TRANSFER' ? row.institution : null,
            institutionOther: tender.method === 'TRANSFER' && row.institution === 'OTHER' ? row.institutionOther : null,
            status: 'UNAPPLIED',
            cashSessionId: attempt.cashSessionId,
            originSaleId: sale.id,
            originAttemptId: attempt.id,
            recordedById: userId,
          },
        });
        collectionIdByMethod.set(tender.method, collection.id);
        collectionAudits.push({
          userId, branchId: sale.branchId, action: 'EXTERNAL_COLLECTION_RECORDED',
          entityType: 'ExternalCollection', entityId: collection.id,
          after: {
            method: tender.method, amount: sealed, referenceKey: row.referenceKey,
            originAttemptId: attempt.id, cashSessionId: attempt.cashSessionId, status: 'UNAPPLIED',
          },
        });
      }
      // Phase 8c: every declaration, in canonical plan order; a CHARGED row
      // points at the collection Phase 8b already created for its method.
      for (const tender of ordered) {
        const row = requestByMethod.get(tender.method)!;
        let externalCollectionId: string | null = null;
        if (row.outcome === 'CHARGED') {
          const collectionId = collectionIdByMethod.get(tender.method);
          if (collectionId === undefined) {
            // Unreachable while Phase 8b walks the same plan; fail closed
            // rather than ever write a CHARGED declaration without its
            // collection.
            throw inconsistentState('La declaración cobrada no conserva su colección externa.');
          }
          externalCollectionId = collectionId;
        }
        const declaration = await tx.checkoutAttemptDeclaration.create({
          data: {
            attemptId: attempt.id,
            saleId: sale.id,
            branchId: sale.branchId,
            method: tender.method,
            tenderSource: tender.source,
            outcome: row.outcome,
            externalCollectionId,
            returnedAmount: row.outcome === 'RETURNED' ? row.returnedAmount : null,
            evidence: row.evidence,
            declaredById: userId,
          },
        });
        if (row.outcome === 'RETURNED') {
          returnedAudits.push({
            userId, branchId: sale.branchId, action: 'CHECKOUT_ATTEMPT_CASH_RETURNED',
            entityType: 'CheckoutAttemptDeclaration', entityId: declaration.id,
            after: { method: tender.method, returnedAmount: row.returnedAmount, evidence: row.evidence },
          });
        }
      }
      audits.push(...collectionAudits, ...returnedAudits);

      // 8d. Fix declaredAt BEFORE releasing any claim (F6).
      const declared = await tx.checkoutAttempt.update({
        where: { id: attempt.id },
        data: { declaredById: userId, declaredAt: now() },
      });
      // The supervisor justification lives in THIS audit row: a REJECTED attempt
      // has no column for it (chk_attempt_status_fields), and a replay reads it
      // back from here (persistedContent).
      audit({
        action: 'CHECKOUT_DECLARATION_RECORDED',
        entityType: 'CheckoutAttempt', entityId: attempt.id,
        after: { status: declared.status, declaredById: userId, declarationCount: ordered.length, supervisor },
      });

      // 8e. Only now release the COLLECTION claims (F6: declaredAt must be set).
      const claimedIds = ordered
        .filter((tender) => tender.source === 'COLLECTION' && tender.externalCollectionId !== null)
        .map((tender) => tender.externalCollectionId!);
      if (claimedIds.length > 0) {
        const released = await tx.externalCollection.updateMany({
          where: { id: { in: claimedIds }, claimAttemptId: attempt.id },
          data: { claimAttemptId: null },
        });
        if (released.count !== claimedIds.length) {
          throw inconsistentState('No se pudieron liberar todas las reservas de cobro registradas.');
        }
        for (const collectionId of claimedIds) {
          audit({
            action: 'EXTERNAL_COLLECTION_CLAIM_RELEASED',
            entityType: 'ExternalCollection', entityId: collectionId,
            before: { claimAttemptId: attempt.id },
            after: { claimAttemptId: null },
          });
        }
      }

      // 9. Audit, after every business write and still inside T-X: a failing
      //    audit rolls the whole close back.
      for (const entry of audits) await createAuditLog(tx, entry);

      // 10. Re-read the terminal, declared attempt and build the view.
      const final = await tx.checkoutAttempt.findUnique({ where: { id: attempt.id } });
      if (!final) throw inconsistentState('La reserva de cobro declarada no se pudo releer.');
      return { replayed: false, view: await loadReservationView(tx, final as LockedAttempt, now()), checkout: null };
    }, { isolationLevel: 'ReadCommitted', timeout: CLOSE_TIMEOUT_MS });
  }

  // T-X: ONE transaction, no retries. 55P03 is the only contention signal and
  // becomes CHECKOUT_RESERVATION_BUSY; a P2002 of the partial EXTERNAL reference
  // indexes becomes EXTERNAL_REFERENCE_ALREADY_RECORDED (the whole transaction,
  // declarations included, has rolled back). Anything else is rethrown.
  async function close(
    req: RequestLike,
    saleId: string,
    reserveKey: string,
    request: CheckoutCloseRequest,
  ): Promise<CheckoutCloseResult> {
    try {
      return await closeOnce(req, saleId, reserveKey, request);
    } catch (error) {
      if (isLockNotAvailable(error)) throw reservationBusy();
      if (isExternalReferenceCollision(error)) throw referenceAlreadyRecorded();
      throw error;
    }
  }

  return { close };
}

export type CheckoutCloseService = ReturnType<typeof createCheckoutCloseService>;
