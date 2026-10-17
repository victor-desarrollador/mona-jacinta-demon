// R3-A4.3 S-REF: HTTP boundary of T-F (the ExternalCollection refund) and of
// the branch listing. It hands the already-validated request to the service
// (the only authority: it locks, checks, writes, audits and commits) and
// serialises the result. A fresh refund and an identical replay are both 200.
// No realtime emission: the refund notifies no client.
import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import {
  createExternalCollectionsService,
  type ExternalCollectionsService,
} from './external-collections.service.js';
import type {
  ExternalCollectionListQuery,
  ExternalCollectionRefundRequest,
} from './dto/external-collection-refund.dto.js';

export function createExternalCollectionsController(
  database: PrismaClient,
  options: { service?: ExternalCollectionsService } = {},
) {
  const service = options.service ?? createExternalCollectionsService(database);

  return {
    refund: (async (req, res) => {
      const result = await service.refund(
        req,
        String(req.params.externalCollectionId),
        req.body as ExternalCollectionRefundRequest,
      );
      sendJson(res.status(200), result);
    }) as RequestHandler,

    list: (async (req, res) => {
      sendJson(res.status(200), await service.list(req, req.query as unknown as ExternalCollectionListQuery));
    }) as RequestHandler,
  };
}
