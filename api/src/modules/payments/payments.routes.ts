import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createPaymentsController } from './payments.controller.js';
import { createCheckoutController } from './checkout.controller.js';
import { createCheckoutQuoteController } from './checkout-quote.controller.js';
import { paymentParamsDto, registerPaymentDto } from './dto/payment.dto.js';
import {
  checkoutConfirmationDto,
  checkoutConfirmationParamsDto,
  checkoutParamsDto,
} from './dto/checkout.dto.js';
import { checkoutQuoteRequestDto } from './dto/checkout-quote.dto.js';
import { checkoutReservationDto, checkoutReservationParamsDto } from './dto/checkout-reservation.dto.js';
import { checkoutCloseDto, checkoutCloseParamsDto } from './dto/checkout-close.dto.js';
import { createCheckoutReservationController } from './checkout-reservation.controller.js';
import { createCheckoutCloseController } from './checkout-close.controller.js';
import type { CheckoutReservationService } from './checkout-reservation.service.js';
import type { CheckoutCloseService } from './checkout-close.service.js';
import type { CheckoutService } from './checkout.service.js';
import type { CheckoutQuoteService } from './checkout-quote.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';

export type PaymentsRouterOptions = {
  checkoutService?: CheckoutService;
  checkoutQuoteService?: CheckoutQuoteService;
  checkoutReservationService?: CheckoutReservationService;
  checkoutCloseService?: CheckoutCloseService;
  // R3-A4.3 S-REF: the PROPORTIONAL_EXTERNAL_METHODS_ENABLED gate, injected by
  // app.ts from the validated env. It is consumed ONLY by the quote (to mark
  // TRANSFER/CARD_DEBIT unavailable and hide the recorded candidates) and the
  // reservation (to refuse a NEW external tender): the refund and the listing are
  // never gated by it. S-REF.1: when undefined (direct construction outside
  // app.ts) it is FAIL-CLOSED — the external methods stay off.
  externalMethodsEnabled?: boolean;
};

export function createPaymentsRouter(
  database: PrismaClient,
  realtime?: RealtimeEmitter,
  options: PaymentsRouterOptions = {},
): Router {
  const router = Router();
  const controller = createPaymentsController(database, realtime);
  const checkout = createCheckoutController(
    database,
    realtime,
    options.checkoutService ? { service: options.checkoutService } : {},
  );
  const quote = createCheckoutQuoteController(
    database,
    options.checkoutQuoteService
      ? { service: options.checkoutQuoteService }
      : { externalMethodsEnabled: options.externalMethodsEnabled },
  );
  const reservation = createCheckoutReservationController(
    database,
    options.checkoutReservationService
      ? { service: options.checkoutReservationService }
      : { externalMethodsEnabled: options.externalMethodsEnabled },
  );
  const close = createCheckoutCloseController(
    database,
    options.checkoutCloseService ? { service: options.checkoutCloseService } : {},
  );
  // R3-A4.3 S4: the durable charge reservation (T-R) and its reload-safe reads.
  // Same global route gate (SALE_CHARGE); the service re-checks SALE_CHARGE and
  // SALE_COMPLETE (reservation) or SALE_CHARGE (reads) at the sale's persisted
  // branch, read under the sale lock for the reservation.
  router.post(
    '/:saleId/checkout/reservations',
    validate(checkoutReservationParamsDto, 'params'),
    validate(checkoutReservationDto),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE),
    reservation.reserve,
  );
  router.get(
    '/:saleId/checkout/reservations',
    validate(checkoutReservationParamsDto, 'params'),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE),
    reservation.list,
  );
  router.get(
    '/:saleId/checkout/reservations/:reserveKey',
    validate(checkoutCloseParamsDto, 'params'),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE),
    reservation.get,
  );
  // R3-A4.3 S6: the close/declaration (T-X). Same global route gate
  // (SALE_CHARGE); the service re-checks SALE_CHARGE (initiator) or the
  // supervisor role at the sale's persisted branch, read under the sale lock.
  // A fresh close and an identical replay are both 200.
  router.post(
    '/:saleId/checkout/reservations/:reserveKey/close',
    validate(checkoutCloseParamsDto, 'params'),
    validate(checkoutCloseDto),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE),
    close.close,
  );
  // R3-A4.1: the read-only quote the POS consults before confirming a charge.
  // Same global route gate (SALE_CHARGE); the service re-checks it at the sale's
  // persisted branch. It writes nothing, locks nothing and notifies no client.
  router.post(
    '/:saleId/checkout/quote',
    validate(checkoutParamsDto, 'params'),
    validate(checkoutQuoteRequestDto),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE),
    quote.quote,
  );
  // R3-A3.3: the proportional settlement path. The route gate is the global
  // SALE_CHARGE; the service re-checks SALE_CHARGE/SALE_COMPLETE at the sale's
  // persisted branch. No branch policy is consulted here (nothing is enabled
  // yet): only a PROPORTIONAL_V1 sale can pass the service.
  router.post(
    '/:saleId/checkout',
    validate(checkoutConfirmationParamsDto, 'params'),
    validate(checkoutConfirmationDto),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE),
    checkout.create,
  );
  router.post('/:saleId/payments', validate(paymentParamsDto, 'params'), validate(registerPaymentDto), requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE), controller.create);
  router.get('/:saleId/payments', validate(paymentParamsDto, 'params'), requirePermission(PRODUCTION_PERMISSIONS.SALE_VIEW), controller.list);
  return router;
}
