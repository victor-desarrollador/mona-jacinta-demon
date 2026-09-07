import type { RequestHandler } from 'express';
import { prisma as defaultPrisma } from '../../config/prisma.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { getProduct, getVariant, listProducts, listVariants } from './products.service.js';

export function createProductsController(database: PrismaClient = defaultPrisma) {
  return {
    listProducts: (async (req, res) => {
      sendJson(res, await listProducts(database, req.query as never));
    }) as RequestHandler,
    getProduct: (async (req, res) => {
      sendJson(res, {
        product: await getProduct(
          database,
          String(req.params.id),
          req.auth?.branchIds ?? [],
        ),
      });
    }) as RequestHandler,
    listVariants: (async (req, res) => {
      sendJson(res, await listVariants(database, req, req.query as never));
    }) as RequestHandler,
    getVariant: (async (req, res) => {
      sendJson(res, {
        variant: await getVariant(
          database,
          String(req.params.id),
          req.auth?.branchIds ?? [],
        ),
      });
    }) as RequestHandler,
  };
}