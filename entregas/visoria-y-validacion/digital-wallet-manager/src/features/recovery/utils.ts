// UBICACIÓN EN TU REPO: digital-wallet-manager/src/features/recovery/utils.ts
// (repositorio: digital-wallet-manager · ruta: src/features/recovery/utils.ts)
// ─── Helpers puros de presentación (cubiertos por utils.test.ts) ────────────
import type { RecoveryOrder, RecoveryProvider, RecoveryStatus } from "./types";

export const PROVIDER_LABELS: Record<string, string> = {
    eneba_wholesale: "Eneba (compra)",
    ez: "EZ",
    wgcards: "WGCards",
    wupex: "Wupex",
    hankgames: "HankGames",
    manastore: "Manastore",
    tisi: "TISI",
    bamboo: "Bamboo",
    cardone: "CardOne",
    icodes: "iCodes",
    coda_voucher: "Coda Voucher",
    visoria: "Visoria",
};

export const providerLabel = (p: RecoveryProvider) => PROVIDER_LABELS[p] ?? p;

export type RecoveryTab = RecoveryStatus | "ALL";

export const TABS: { value: RecoveryTab; label: string; hint: string }[] = [
    { value: "ALL", label: "Todas", hint: "" },
    { value: "PENDING", label: "Pendientes", hint: "Faltan códigos y aún están dentro del período normal de recuperación." },
    { value: "UNRECOVERED", label: "En recuperación", hint: "Superaron los días límite o el proveedor las marcó como fallidas." },
    { value: "RECOVERED", label: "Completadas", hint: "Recibieron el 100 % de los códigos solicitados." },
];

export type StatusBadge = { label: string; tone: "amber" | "orange" | "red" | "emerald" };

export function statusBadge(order: Pick<RecoveryOrder, "status" | "is_partial" | "retried_manually">): StatusBadge {
    if (order.status === "RECOVERED") {
        return { label: `Completada${order.retried_manually ? " (manual)" : ""}`, tone: "emerald" };
    }
    if (order.status === "UNRECOVERED") {
        return { label: order.is_partial ? "En recuperación · parcial" : "En recuperación", tone: "red" };
    }
    return order.is_partial ? { label: "Parcial", tone: "orange" } : { label: "Pendiente", tone: "amber" };
}

/** "3 h", "1 d 4 h", "—" */
export function formatAge(hours: number | null | undefined): string {
    if (hours === null || hours === undefined || Number.isNaN(hours)) return "—";
    if (hours < 1) return `${Math.max(Math.round(hours * 60), 0)} min`;
    if (hours < 24) return `${Math.floor(hours)} h`;
    const d = Math.floor(hours / 24);
    const h = Math.floor(hours % 24);
    return h ? `${d} d ${h} h` : `${d} d`;
}

export function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

/** Horas que faltan para pasar a recuperación (negativo si ya pasó); null si no aplica. */
export function hoursUntilRecovery(order: Pick<RecoveryOrder, "status" | "age_hours" | "recovery_after_days">): number | null {
    if (order.status !== "PENDING" || order.age_hours === null || order.age_hours === undefined) return null;
    return order.recovery_after_days * 24 - order.age_hours;
}

/** Porcentaje recibido (0–100), null si no se conoce lo solicitado. */
export function progressPct(order: Pick<RecoveryOrder, "requested_quantity" | "received_quantity">): number | null {
    if (!order.requested_quantity) return null;
    return Math.min(100, Math.round((order.received_quantity / order.requested_quantity) * 100));
}

export const canRetry = (order: Pick<RecoveryOrder, "can_retry" | "status" | "remaining_quantity">) =>
    order.can_retry ?? (order.status !== "RECOVERED" && (order.remaining_quantity ?? 1) > 0);

export function attemptSourceLabel(source?: string): string {
    if (source === "manual") return "Manual";
    if (source === "auto_resume") return "Ciclo automático";
    return "Compra";
}

export const STATUS_OPTIONS: { value: RecoveryStatus; label: string; hint: string }[] = [
    { value: "PENDING", label: "Pendiente", hint: "El sistema la vuelve a consultar sola en cada ciclo durante 2 días y no recompra lo que falta." },
    { value: "UNRECOVERED", label: "En recuperación", hint: "Queda para revisar a mano; el sistema ya no la espera." },
    { value: "RECOVERED", label: "Completada", hint: "Se cierra. Úsalo si ya resolviste los códigos por fuera." },
];