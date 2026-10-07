import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createRequireAuth } from '../../middleware/auth.js';
import { createFailedAttemptLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validation.js';
import { createAuthController } from './auth.controller.js';
import { loginSchema, type LoginInput } from './dto/login.dto.js';

// Pre-pilot fix 2A: 10 failed logins per account per 15 minutes. Runs after
// validate(loginSchema), so malformed bodies never consume the budget and the
// key is derived only from the validated, trimmed email (lower-cased, hashed).
function createLoginAttemptLimiter() {
  return createFailedAttemptLimiter({
    windowMs: 15 * 60_000,
    limit: 10,
    message: 'Demasiados intentos de inicio de sesión. Intentá nuevamente más tarde.',
    keyGenerator: (req) => {
      const email = (req.body as LoginInput).email.toLowerCase();
      return `login:${createHash('sha256').update(email).digest('hex')}`;
    },
  });
}

export function createAuthRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createAuthController(database);
  router.post('/login', validate(loginSchema), createLoginAttemptLimiter(), controller.loginHandler);
  router.get('/me', createRequireAuth(database), controller.meHandler);
  return router;
}
