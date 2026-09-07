import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../shared/errors.js';
import { sendJson } from '../shared/json-safe.js';
import { logger } from '../shared/logger.js';

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  next,
) => {
  if (res.headersSent) {
    // Express may log errors passed to its default handler: use a safe replacement.
    next(new Error('Response could not be completed'));
    return;
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Ocurrió un error interno.';
  let details: unknown;

  if (error instanceof AppError) {
    ({ status, code, message, details } = error);
  } else if (error instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Los datos enviados no son válidos.';
    details = error.issues.map((issue) => ({
      path: issue.path.map(String),
      code: issue.code,
    }));
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002' || error.code === 'P2003') {
      status = 409;
      code = 'DATABASE_CONFLICT';
      message = 'La operación entra en conflicto con los datos existentes.';
    } else if (error.code === 'P2025') {
      status = 404;
      code = 'NOT_FOUND';
      message = 'No se encontró el recurso.';
    }
  } else if (error instanceof Error && 'type' in error) {
    // body-parser errors can contain the original request body; never expose it.
    if (error.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'El cuerpo de la solicitud no contiene JSON válido.';
    } else if (error.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'La solicitud supera el tamaño permitido.';
    }
  }

  if (status >= 500) logger.error({ event: 'request_failed', status });
  sendJson(res.status(status), {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
};
