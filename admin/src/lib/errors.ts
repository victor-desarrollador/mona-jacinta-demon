import { ApiError } from './api';

// Server messages are already Spanish and sanitized (api errorHandler never
// exposes Prisma/internal detail; 5xx is always a generic message). A
// non-ApiError is a network/runtime failure whose raw text is not
// user-facing, so it is replaced by the caller's fallback.
export function errorMessage(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return 'Tu sesión expiró. Volvé a ingresar.';
    if (cause.status === 403) return 'No tenés permiso para realizar esta acción.';
    if (cause.status >= 500) return 'Ocurrió un error en el servidor. Intentá nuevamente.';
    return cause.message;
  }
  return fallback;
}
