// Transporte HTTP del POS. Movido tal cual desde page.tsx (apiRequest, apiRequestCoded, userFacingError) y desde
// ProportionalChargePanel.tsx (CodedApiError) para que más de un módulo del cliente hable con la API sin importar de una
// `page` (Next sólo admite exports de página en page.tsx). Ninguna lógica cambió.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

type ApiError = { message?: string; error?: { code?: string; message?: string } };

// USER-MGMT-01 U5 — answers that mean "this SESSION cannot continue as it is", whichever request raised them. They are broadcast once from the
// transport so the page reacts in one place (page.tsx) instead of every workspace handling them. Only for requests made WITH a token.
export const SESSION_SIGNAL_EVENT = "mona-pos:session-signal";
export type SessionSignalCode = "PASSWORD_CHANGE_REQUIRED" | "INACTIVE_USER";
function signalSessionState(token: string | null, code: string | undefined) {
  if (token && (code === "PASSWORD_CHANGE_REQUIRED" || code === "INACTIVE_USER")) {
    window.dispatchEvent(new CustomEvent<SessionSignalCode>(SESSION_SIGNAL_EVENT, { detail: code }));
  }
}

// El error de transporte del circuito proporcional: conserva el status, el
// código y los `details` de la respuesta, porque son lo único que permite
// distinguir una cotización vencida de un fallo de red. El resto del POS usa
// `apiRequest`, que los descarta a propósito (ver page.tsx).
export class CodedApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, status: number | null, code: string | null, details: unknown) {
    super(message);
    this.name = "CodedApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function userFacingError(message: string | undefined, fallback: string) {
  const labels: Record<string, string> = {
    Unauthorized: "No autorizado.",
    Forbidden: "No tenés permiso para realizar esta acción.",
    "Invalid credentials": "Usuario o contraseña incorrectos.",
  };
  return message ? (labels[message] ?? message) : fallback;
}

export async function apiRequest<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiError = body as ApiError;
    signalSessionState(token, apiError.error?.code);
    const fallback =
      response.status === 401
        ? "No autorizado."
        : response.status === 403
          ? "No tenés permiso para realizar esta acción."
          : "No se pudo completar la operación.";
    throw new Error(userFacingError(apiError.message ?? apiError.error?.message, fallback));
  }

  return body as T;
}

// R3-A4.2b: el mismo transporte, pero conservando el código y los `details`
// que la respuesta traiga. Lo usa EXCLUSIVAMENTE el circuito proporcional: sin
// ellos el POS no puede distinguir una cotización vencida (409
// CHECKOUT_QUOTE_CHANGED, con el importe vigente) de un fallo de red, y
// `apiRequest` los descarta a propósito para el resto de las operaciones.
export async function apiRequestCoded(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const failure = body as {
      error?: { code?: string; message?: string; details?: unknown };
      message?: string;
    };
    signalSessionState(token, failure.error?.code);
    const fallback =
      response.status === 401
        ? "No autorizado."
        : response.status === 403
          ? "No tenés permiso para realizar esta acción."
          : "No se pudo completar la operación.";
    throw new CodedApiError(
      userFacingError(failure.message ?? failure.error?.message, fallback),
      response.status,
      failure.error?.code ?? null,
      failure.error?.details ?? null,
    );
  }

  return body;
}
