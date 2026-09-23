import type { RequestHandler } from 'express';
import { prisma as defaultPrisma } from '../../config/prisma.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { getProduct, getVariant, listProducts, listVariants } from './products.service.js';
import { createCatalogAdminService } from './catalog-admin.service.js';

export function createProductsController(database: PrismaClient = defaultPrisma) {
  const catalog = createCatalogAdminService(database);
  return {
    listCategories: (async (_req, res) => {
      sendJson(res, { items: await catalog.listCategories() });
    }) as RequestHandler,
    listBrands: (async (_req, res) => {
      sendJson(res, { items: await catalog.listBrands() });
    }) as RequestHandler,
    createProduct: (async (req, res) => {
      sendJson(res.status(201), { product: await catalog.createProduct(req.auth!.userId, req.body) });
    }) as RequestHandler,
    createVariant: (async (req, res) => {
      sendJson(res.status(201), { variant: await catalog.createVariant(req.auth!.userId, req.body) });
    }) as RequestHandler,
    updateVariantPrice: (async (req, res) => {
      sendJson(res, {
        variant: await catalog.updateVariantPrice(req.auth!.userId, String(req.params.id), req.body),
      });
    }) as RequestHandler,
    listProducts: (async (req, res) => {
      sendJson(res, await listProducts(database, req.query as never));
    }) as RequestHandler,
    getProduct: (async (req, res) => {
      sendJson(res, {
        product: await getProduct(
          database,
          String(req.params.id),
          req.auth?.effectiveLocationIds ?? [],
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
          req.auth?.effectiveLocationIds ?? [],
        ),
      });
    }) as RequestHandler,
  };
}