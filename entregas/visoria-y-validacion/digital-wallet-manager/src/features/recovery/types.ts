// UBICACIÓN EN TU REPO: digital-wallet-manager/src/features/recovery/types.ts
// (repositorio: digital-wallet-manager · ruta: src/features/recovery/types.ts)
// ─── Tipos del módulo Recuperación de Órdenes a Proveedores ─────────────────
// Reflejan provider_recovery_log (ver backend: app/routes/recovery.py y
// app/services/provider_order_tracking.py).

/** Código de proveedor tal como lo guarda el backend. Abierto a proveedores futuros. */
export type RecoveryProvider =
    | "eneba_wholesale"
    | "ez"
    | "wgcards"
    | "wupex"
    | "hankgames"
    | "manastore"
    | "tisi"
    | "bamboo"
    | "cardone"
    | "icodes"
    | "coda_voucher"
    | "visoria"
    | (string & {});

/**
 * PENDING      → Pendiente: faltan códigos, dentro de los 2 días
 *                (si received_quantity > 0 se muestra como "Parcial").
 * UNRECOVERED  → En recuperación: > 2 días o fallida en el proveedor.
 * RECOVERED    → Completada: se recibió el 100 % de lo solicitado.
 */
export type RecoveryStatus = "PENDING" | "UNRECOVERED" | "RECOVERED";

export interface RecoveryOrder {
    id: number;
    provider: RecoveryProvider;
    product_id: number | null;
    product_name: string | null;
    order_ref: string;
    stage_at_resolution: string | null;
    status: RecoveryStatus;
    codes_count: number;
    requested_quantity: number | null;   // null solo en órdenes antiguas sin cantidad registrada
    received_quantity: number;
    remaining_quantity: number | null;
    attempt_count: number | null;
    last_attempt_at: string | null;
    recovery_due_at: string | null;
    moved_to_recovery_at: string | null;
    original_created_at: string | null;
    original_expires_at: string | null;
    resolved_at: string;
    retried_manually: boolean;
    created_at?: string | null;
    // Derivados por el backend
    age_hours: number | null;
    is_partial: boolean;
    can_retry: boolean;
    recovery_after_days: number;
    /** Nº de orden del proveedor (p. ej. "H275060"); null si no se conoce. */
    provider_order_id?: string | null;
    /** false para proveedores que compran por unidad (TISI, Coda): no tienen Nº de orden. */
    can_edit_provider_order_id?: boolean;
}

export interface RecoveryAttempt {
    n: number;
    type: "attempt" | "moved_to_recovery" | "resolved" | "manual_edit" | (string & {});
    at: string;
    source?: "auto" | "auto_resume" | "manual" | string;
    requested?: number | null;
    received?: number;
    total_received?: number;
    remaining?: number | null;
    duplicates_rejected?: number;
    reinserted?: number;
    status?: RecoveryStatus;
    error?: string;
    reason?: string | null;
    stage?: string;
}

export interface RecoveryOrderDetail extends RecoveryOrder {
    attempts: RecoveryAttempt[];
}

export interface RecoverySummary {
    pending_count: number;
    partial_count: number;
    unrecovered_count: number;
    recovered_count: number;
}

export interface RetryResult {
    success: boolean;
    message: string;
    status?: RecoveryStatus;
    codes_recovered?: number;
    codes_inserted_inventory?: number;
    duplicates_rejected?: number;
    requested_quantity?: number | null;
    received_quantity?: number | null;
    remaining_quantity?: number | null;
    error?: string | null;
    order?: RecoveryOrder;
}
export interface RecoveryOrderEdit {
    provider_order_id?: string;
    status?: RecoveryStatus;
    note?: string;
    /** Completar una orden parcial con lo recibido (el proveedor no entregó ni cobró el resto). */
    close_with_received?: boolean;
}

export interface EditResult {
    success: boolean;
    message: string;
    order?: RecoveryOrder;
}