import type { ExchangeDraft, RecoveryReason } from "./exchange-draft-store";

// Cambios de prenda — what the cashier reads. Three situations must never be mistaken for each other, because confusing them duplicates
// stock movements:
//   REJECTED   "no se pudo hacer"             the server refused BEFORE writing anything: nothing happened, the draft can be corrected.
//   UNCERTAIN  "no sabemos si se hizo"        the answer was lost: it MAY have been registered. Never a blind second attempt.
//   CONFIRMED  "se hizo, falta refrescar"     registered. Only the view of the sale is old.

// What the screen is showing for a draft, derived ONLY from the store's draft (attempt + recovery). Nothing here is a second source of truth.
export type DraftView =
  | "EDITABLE" // no attempt, or a REJECTED one: the draft can be corrected and sent again
  | "SENDING"
  | "UNCERTAIN"
  | "CONFIRMED"
  | "RESOLVED_ELSEWHERE"
  | "STALE_BASELINE"
  | "RECOVERY_REQUIRED";

const RECOVERY_VIEW: Record<RecoveryReason, DraftView> = {
  UNREADABLE: "RECOVERY_REQUIRED",
  STORAGE_ERROR: "RECOVERY_REQUIRED",
  RESOLVED_ELSEWHERE: "RESOLVED_ELSEWHERE",
  CONFIRMED: "CONFIRMED",
  STALE_BASELINE: "STALE_BASELINE",
};

export function draftView(draft: Pick<ExchangeDraft, "attempt" | "recovery">): DraftView {
  if (draft.recovery) return RECOVERY_VIEW[draft.recovery.reason];
  const status = draft.attempt?.status;
  return status === "SENDING" || status === "UNCERTAIN" || status === "CONFIRMED" ? status : "EDITABLE";
}

export const isCritical = (view: DraftView) => view !== "EDITABLE";

export const REJECTION_TITLE = "No se pudo hacer el cambio. No se registró nada.";

const REJECTIONS: Record<string, string> = {
  NO_OP_EXCHANGE: "El reemplazo es la misma prenda que se devuelve: no hay nada que cambiar.",
  REPLACEMENT_CHEAPER_NOT_SUPPORTED: "El reemplazo es más barato que la prenda original. Solo se admiten cambios de igual precio.",
  REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED: "El reemplazo es más caro que la prenda original. Solo se admiten cambios de igual precio.",
  INSUFFICIENT_STOCK: "No hay stock suficiente del reemplazo en esta sucursal.",
  EXCHANGE_QUANTITY_EXCEEDED: "La cantidad a devolver supera lo que queda por cambiar de esa prenda.",
  SALE_ITEM_MISMATCH: "Una de las prendas no pertenece a esta venta. Volvé a consultar la venta.",
  INVALID_SALE_STATE: "La venta no puede cambiarse en su estado actual.",
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: "El servidor ya tiene un intento de esta venta con otro contenido. No se registró nada nuevo: consultá con soporte.",
  SALE_EXCHANGE_STOCK_INCONSISTENT: "El stock de esta venta es inconsistente y el cambio no se registró. Avisá a soporte.",
};

// The code stays visible: it is what support asks for.
export function rejectionText(code: string | null, serverMessage: string | null): string {
  const text = (code && REJECTIONS[code]) || serverMessage || "El servidor rechazó el cambio.";
  return code ? `${text} (código ${code})` : text;
}

export const UNCERTAIN_TEXT =
  "No pudimos confirmar si el cambio se registró. No edites ni vuelvas a iniciar el cambio. Usá «Verificar el cambio» para consultar y reintentar de forma segura el mismo intento: no es un segundo cambio.";

export const CONFIRMED_REFRESH_FAILED_TEXT =
  "El cambio fue confirmado, pero no pudimos actualizar la venta. Volvé a consultar antes de hacer otro cambio.";

export const STALE_TEXT = "La venta cambió desde la última lectura. Volvé a consultarla antes de continuar.";

export const RESOLVED_ELSEWHERE_TEXT =
  "Este cambio se resolvió en otra pestaña y no sabemos si se registró. No lo repitas: actualizá la venta para ver cómo quedó.";

export const RECOVERY_TEXT =
  "No se puede leer el registro local de este cambio, así que no se puede operar sobre esta venta desde este navegador. No lo repitas: avisá a soporte.";

const REFRESH_FAILURES: Record<string, string> = {
  READ_FAILED: "No pudimos consultar la venta. Reintentá en unos segundos.",
  READ_INVALID: "La respuesta del servidor no es válida. Reintentá.",
  READ_MISMATCH: "La respuesta no corresponde a esta venta o sucursal.",
  READ_STALE: "La lectura de la venta es anterior a un cambio ya registrado. Reintentá en unos segundos.",
  NOT_EXCHANGEABLE: "La venta ya no admite cambios.",
  NOTHING_LEFT_TO_EXCHANGE: "En esta venta ya no queda ninguna prenda para cambiar.",
  STATE_CHANGED: "El estado de este cambio se modificó mientras se actualizaba la venta. Reintentá.",
  NOT_BLOCKED_BY_REFRESH: "No hay nada que actualizar para esta venta.",
  PERSIST_FAILED: "No se pudo guardar la actualización en el almacenamiento del navegador.",
};

export const refreshFailureText = (reason: string) => REFRESH_FAILURES[reason] ?? "No pudimos actualizar la venta.";
