import { clsx, type ClassValue } from 'clsx';
import { cva } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatARS(centsValue: string) {
  const value = BigInt(centsValue);
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const pesos = absolute / 100n;
  const cents = absolute % 100n;
  const grouped = pesos.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}ARS ${grouped},${cents.toString().padStart(2, '0')}`;
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatVariant(color?: string | null, size?: string | null) {
  return [color, size].filter(Boolean).join(' / ') || 'Única';
}

export function isLowStock(available: string) {
  const value = BigInt(available);
  return value >= 0n && value <= 3n;
}

export const statusBadge = cva('status-badge', {
  variants: {
    status: {
      DRAFT: 'draft',
      PENDING_PAYMENT: 'pending_payment',
      PAID: 'paid',
      COMPLETED: 'completed',
      CANCELLED: 'cancelled',
    },
  },
});

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    DRAFT: 'Borrador',
    PENDING_PAYMENT: 'Pendiente de pago',
    PAID: 'Pagada',
    COMPLETED: 'Completada',
    CANCELLED: 'Cancelada',
  };
  return labels[status] ?? status;
}

export function paymentMethodLabel(method: string) {
  const labels: Record<string, string> = {
    CASH: 'Efectivo',
    TRANSFER: 'Transferencia',
    CARD_DEBIT: 'Tarjeta de débito',
    CARD_CREDIT: 'Tarjeta de crédito',
    QR: 'QR',
  };
  return labels[method] ?? method;
}

export function roleLabel(role: string) {
  const labels: Record<string, string> = {
    SELLER: 'Vendedor',
    CASHIER: 'Cajero',
    MANAGER: 'Gerente',
    ADMIN: 'Administrador',
  };
  return labels[role] ?? role;
}
