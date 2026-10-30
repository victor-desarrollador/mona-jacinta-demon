import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requireAnyPermission, requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { saleIdDto } from './dto/sale.dto.js';
import { cancelSaleDto } from './dto/cancel-sale.dto.js';
import { voidSaleDto } from './dto/void-sale.dto.js';
import { createCancellationController } from './cancellation.controller.js';
import { createSaleVoidController } from './sale-void.controller.js';
import { createSaleExchangeReadService } from './sale-exchange-read.service.js';
import { exchangeableSaleQueryDto } from './dto/exchangeable-sale-query.dto.js';
import { createSaleExchangeReplacementsService } from './sale-exchange-replacements.service.js';
import { exchangeReplacementsQueryDto } from './dto/exchange-replacements-query.dto.js';
import { sendJson } from '../../shared/json-safe.js';
import { createSaleExchangeController } from './sale-exchange.controller.js';
import { exchangeSaleHttpDto } from './dto/exchange-sale.dto.js';
import type { SaleVoidService } from './sale-void.service.js';
import type { SaleExchangeService } from './sale-exchange.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';

// `saleVoidService` / `saleExchangeService` are test seams (the HTTP tests inject a recorder); production builds the real services.
export function createCancellationRouter(
  database: PrismaClient,
  realtime?: RealtimeEmitter,
  options: { saleVoidService?: SaleVoidService; saleExchangeService?: SaleExchangeService } = {},
): Router {
  const router = Router();
  const controller = createCancellationController(database, realtime);
  // Pilot P0.2-B: coarse gate only; cancelSale decides DRAFT (own, SALE_CREATE)
  // vs PENDING_PAYMENT (SALE_CANCEL_PENDING) on the locked, persisted sale.
  router.post(
    '/:saleId/cancel',
    validate(saleIdDto, 'params'),
    validate(cancelSaleDto),
    requireAnyPermission([PRODUCTION_PERMISSIONS.SALE_CREATE, PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING]),
    controller.cancel,
  );
  // Sale void v1: the post-payment void, a route of its own (never /cancel). Params are validated first, then
  // the coarse SALE_VOID gate (an unauthenticated or unauthorized caller learns nothing about the body), then the
  // strict body. The definitive decision (OWNER / COMPANY-scoped ADMIN at the sale's persisted branch) is the
  // service's, not this gate's.
  const voidController = createSaleVoidController(database, realtime, { saleVoidService: options.saleVoidService });
  router.post(
    '/:saleId/void',
    validate(saleIdDto, 'params'),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_VOID),
    validate(voidSaleDto),
    voidController.voidSale,
  );
  // The read the Cambios UI needs (sold / exchanged / remaining per item). Registered here, i.e. BEFORE GET /:saleId in the sales router,
  // so `exchangeable` is never parsed as a sale id. Same two gates as the POST: the coarse SALE_EXCHANGE permission, then the supervisor
  // decision against the requested branch inside the service. Read-only.
  const exchangeReadService = createSaleExchangeReadService(database);
  router.get(
    '/exchangeable',
    requirePermission(PRODUCTION_PERMISSIONS.SALE_EXCHANGE),
    validate(exchangeableSaleQueryDto, 'query'),
    (async (req, res) => {
      sendJson(res, await exchangeReadService.findExchangeableSale(req, req.query));
    }) as RequestHandler,
  );
  // The replacement candidates for one SaleItem, each with the unit price the exchange would charge (same pricing function as the POST below)
  // and whether it is EQUAL / CHEAPER / MORE_EXPENSIVE. Same gates as GET /exchangeable: the coarse SALE_EXCHANGE permission, then the
  // supervisor decision against the requested branch inside the service, BEFORE any lookup. Read-only; the POST stays the authority.
  const replacementsService = createSaleExchangeReplacementsService(database);
  router.get(
    '/:saleId/exchange-replacements',
    requirePermission(PRODUCTION_PERMISSIONS.SALE_EXCHANGE),
    validate(saleIdDto, 'params'),
    validate(exchangeReplacementsQueryDto, 'query'),
    (async (req, res) => {
      sendJson(res, await replacementsService.findReplacements(req, String(req.params.saleId), req.query));
    }) as RequestHandler,
  );
  // Sale exchange v1: a COMPLETED sale -> garment swap of equal value. Same order as the void: params, the coarse SALE_EXCHANGE gate, then the
  // strict body. The definitive decision (OWNER / COMPANY-scoped ADMIN holding SALE_EXCHANGE at the sale's persisted branch) is the service's.
  const exchangeController = createSaleExchangeController(database, realtime, { saleExchangeService: options.saleExchangeService });
  router.post(
    '/:saleId/exchanges',
    validate(saleIdDto, 'params'),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_EXCHANGE),
    validate(exchangeSaleHttpDto),
    exchangeController.exchangeSale,
  );
  return router;
}

export function createReservationAdminRouter(database: PrismaClient, realtime?: RealtimeEmitter): Router {
  const router = Router();
  const controller = createCancellationController(database, realtime);
  router.post('/reservations/release-expired', requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_MANAGE), controller.releaseExpired);
  return router;
}
