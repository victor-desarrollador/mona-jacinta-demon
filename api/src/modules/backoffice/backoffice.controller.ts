import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createBackofficeService } from './backoffice.service.js';
import { createScopeAssignmentService } from './scope-assignment.service.js';
import type { AssignScopeInput } from './scope-assignment.dto.js';
import type { RoleCode } from '../rbac/roles.js';

export function createBackofficeController(database: PrismaClient) {
  const service = createBackofficeService(database);
  const scopeAssignmentService = createScopeAssignmentService(database);
  return {
    dashboard: (async (req, res) => {
      sendJson(res, await service.dashboard(req));
    }) as RequestHandler,
    sales: (async (req, res) => {
      sendJson(res, await service.listSales(req, req.query as never));
    }) as RequestHandler,
    saleDetail: (async (req, res) => {
      sendJson(res, await service.getSale(req, String(req.params.id)));
    }) as RequestHandler,
    inventory: (async (req, res) => {
      sendJson(res, await service.inventory(req, req.query as never));
    }) as RequestHandler,
    branches: (async (req, res) => {
      sendJson(res, await service.branches(req));
    }) as RequestHandler,
    users: (async (req, res) => {
      sendJson(res, await service.users(req));
    }) as RequestHandler,
    // Phase 1D.4.4: thin HTTP wiring only — every authorization/business
    // invariant (self-modification, OWNER guards, role/scope compatibility,
    // per-(user, roleId) mutation isolation, target-row locking) lives in
    // the already-approved scope-assignment.service.ts (Task 1D.4.3) and is
    // never duplicated here. `req.body`/`req.params` are already the
    // validate() middleware's parsed output by the time these run (see
    // backoffice.routes.ts) — the casts below describe that already-checked
    // shape, they do not themselves validate anything.
    assignScope: (async (req, res) => {
      sendJson(res, await scopeAssignmentService.assign(req, String(req.params.userId), req.body as AssignScopeInput));
    }) as RequestHandler,
    revokeScope: (async (req, res) => {
      sendJson(res, await scopeAssignmentService.revoke(req, String(req.params.userId), req.params.roleCode as RoleCode));
    }) as RequestHandler,
  };
}
