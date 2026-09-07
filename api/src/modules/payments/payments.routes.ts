import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createPaymentsController } from './payments.controller.js';
import { paymentParamsDto, registerPaymentDto } from './dto/payment.dto.js';

export function createPaymentsRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createPaymentsController(database);
  router.post('/:saleId/payments', validate(paymentParamsDto, 'params'), validate(registerPaymentDto), requirePermission(PERMISSIONS.SALE_CHARGE), controller.create);
  router.get('/:saleId/payments', validate(paymentParamsDto, 'params'), requirePermission(PERMISSIONS.SALE_VIEW), controller.list);
  return router;
}