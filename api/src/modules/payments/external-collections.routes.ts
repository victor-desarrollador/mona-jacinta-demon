// R3-A4.3 S-REF: /api/v1/external-collections, mounted in app.ts after
// authentication and outside the /sales/:saleId router (C1–C5 §4.1/§8).
//
// There is deliberately NO coarse route-level permission gate here: the
// service is the single authority and resolves two different questions per
// request — the refund needs the SALE_CANCEL_PENDING SUPERVISOR policy on the
// locked collection's branch, while the listing is either that same supervisor
// (whole branch) or a SALE_CHARGE holder (own rows only). A single global gate
// could not express either, and the listing permission must never enable the
// refund.
import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { validate } from '../../middleware/validation.js';
import {
  createExternalCollectionsController,
} from './external-collections.controller.js';
import {
  externalCollectionListQueryDto,
  externalCollectionParamsDto,
  externalCollectionRefundDto,
} from './dto/external-collection-refund.dto.js';
import type { ExternalCollectionsService } from './external-collections.service.js';

export function createExternalCollectionsRouter(
  database: PrismaClient,
  options: { service?: ExternalCollectionsService } = {},
): Router {
  const router = Router();
  const controller = createExternalCollectionsController(database, options);

  router.get('/', validate(externalCollectionListQueryDto, 'query'), controller.list as RequestHandler);
  router.post(
    '/:externalCollectionId/refund',
    validate(externalCollectionParamsDto, 'params'),
    validate(externalCollectionRefundDto),
    controller.refund as RequestHandler,
  );

  return router;
}
