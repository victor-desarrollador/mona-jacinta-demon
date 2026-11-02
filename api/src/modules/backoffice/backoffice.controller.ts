import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createBackofficeService } from './backoffice.service.js';
import { createScopeAssignmentService } from './scope-assignment.service.js';
import { createUserAdminService } from './user-admin.service.js';
import type { AdminOperationInput, CreateUserInput, UpdateUserInput } from './user-admin.dto.js';
import type { AssignScopeInput } from './scope-assignment.dto.js';
import type { RoleCode } from '../rbac/roles.js';
import { createNoopSessionRevoker, type SessionRevoker } from '../../realtime/session-revoker.js';

export function createBackofficeController(database: PrismaClient, sessionRevoker: SessionRevoker = createNoopSessionRevoker()) {
  const service = createBackofficeService(database);
  const scopeAssignmentService = createScopeAssignmentService(database, sessionRevoker);
  const userAdminService = createUserAdminService(database, sessionRevoker);
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
    // USER-MGMT-01 U2: the identity lifecycle. Same thin wiring: body/params are already the validate() middleware's parsed output, and
    // every decision (authority, idempotency, atomicity) lives in user-admin.service.ts. The response carries the temporary password
    // exactly once; the router sets Cache-Control: no-store before any of these handlers (and so on their error answers too).
    createUser: (async (req, res) => {
      const result = await userAdminService.create(req, req.body as CreateUserInput);
      res.status(result.replayed ? 200 : 201);
      sendJson(res, result);
    }) as RequestHandler,
    updateUser: (async (req, res) => {
      sendJson(res, await userAdminService.update(req, String(req.params.userId), req.body as UpdateUserInput));
    }) as RequestHandler,
    deactivateUser: (async (req, res) => {
      sendJson(res, await userAdminService.deactivate(req, String(req.params.userId), req.body as AdminOperationInput));
    }) as RequestHandler,
    reactivateUser: (async (req, res) => {
      sendJson(res, await userAdminService.reactivate(req, String(req.params.userId), req.body as AdminOperationInput));
    }) as RequestHandler,
    resetUserPassword: (async (req, res) => {
      sendJson(res, await userAdminService.resetPassword(req, String(req.params.userId), req.body as AdminOperationInput));
    }) as RequestHandler,
  };
}
