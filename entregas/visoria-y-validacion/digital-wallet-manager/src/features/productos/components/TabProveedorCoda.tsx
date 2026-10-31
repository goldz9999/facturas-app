// UBICACIÓN EN TU REPO: digital-wallet-manager/src/features/productos/components/TabProveedorCoda.tsx
// (repositorio: digital-wallet-manager · ruta: src/features/productos/components/TabProveedorCoda.tsx)
// ─── Tab Proveedores / Variantes (Recarga Directa) ─────────────────────────
// Un producto puede tener varias VARIANTES (denominaciones distintas, ej.
// "5 Diamantes" / "100 Diamantes"), cada una mapeada a un SKU de un
// proveedor (Coda, Hankgames o Visoria). Separado a propósito de TabProveedores.tsx
// (que es para codigos/vouchers).
//
// Flujo en 2 pasos para no pedir el catálogo entero de una:
//   1. Elegir el proveedor y el juego (Coda: GET /products; Hankgames: categorías;
//      Visoria: búsqueda por nombre, no tiene listado).
//   2. Recién ahí se piden los SKUs de ESE juego (on-demand, en vivo).
//
// Cada paso se monta como un componente hijo separado con su propia key
// (GameStep / SkuStep) para que React SIEMPRE desmonte por completo un
// paso antes de montar el otro - nunca reutiliza ni mezcla estado/DOM
// entre pantallas.
//
// Respaldo: variantes con el mismo variant_key son la misma recarga en
// distintos proveedores. El motor de yape-gaming:
//   - valida preguntando en orden de priority (solo variantes que validan)
//     hasta que un proveedor devuelve el nombre del jugador;
//   - recarga del más barato al más caro, y solo pasa al siguiente si el
//     proveedor rechaza la recarga.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
    Search, Loader2, Save, Trash2, Check, Gamepad2, Plus, Pencil, ChevronLeft, RefreshCw,
    ArrowUp, ArrowDown, ShieldCheck, Layers, Zap,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import {
    fetchCodaProducts, fetchCodaProductSkus, fetchHankgamesCategories, fetchHankgamesCategoryProducts,
    fetchVisoriaGames, fetchVisoriaGameProducts,
    fetchDirectTopupVariants, apiAddDirectTopupVariant, apiUpdateDirectTopupVariant, apiDeleteDirectTopupVariant,
    apiSyncDirectTopupVariantPrice,
} from "../api";
import type { CodaSkuEntry, VisoriaSkuEntry, Product, DirectTopupVariant, DirectTopupProvider } from "../types";

const PROVIDER_LABEL: Record<string, string> = { coda: "Coda", hankgames: "Hankgames", visoria: "Visoria" };
const PROVIDERS: DirectTopupProvider[] = ["coda", "hankgames", "visoria"];
// Proveedores que pueden decir de quién es la cuenta. Visoria solo recarga.
const CAN_VALIDATE = new Set(["coda", "hankgames"]);

// Juego elegido en el paso 1, igual para los dos proveedores. Hankgames no
// dice qué datos pide cada juego: subtype queda null y se elige a mano.
interface GameOption {
    name: string;
    ref: string;          // Coda: apiPath · Hankgames: categoryId · Visoria: nombre del juego
    subtype: number | null;
    haveRole: boolean;
}

function subtypeText(subtype: number | null | undefined, haveRole = false): string {
    const base = subtype === 2 ? "User ID + Server ID"
        : subtype === 3 ? "User ID + Zone ID"
            : "User ID"; // subtype 1, 0 (vouchers) u otro caso no documentado
    return haveRole ? `${base} + Role ID` : base;
}

const providerOf = (v: DirectTopupVariant) => (v.provider || "coda") as string;
const groupKeyOf = (v: DirectTopupVariant) => v.variant_key || `v${v.id}`;
const variantName = (v: DirectTopupVariant) => v.variant_label || v.title || v.coda_sku;
const validatesOf = (v: DirectTopupVariant) => CAN_VALIDATE.has(providerOf(v)) && v.validates !== false;

function ProviderBadge({ provider }: { provider: string }) {
    return (
        <Badge variant="outline" className={cn("text-[10px] whitespace-nowrap",
            provider === "hankgames" ? "text-amber-400 border-amber-400/30"
                : provider === "visoria" ? "text-violet-400 border-violet-400/30" : "text-sky-400 border-sky-400/30")}>
            {PROVIDER_LABEL[provider] ?? provider}
        </Badge>
    );
}

function GameStep({ provider, onSelect }: { provider: DirectTopupProvider; onSelect: (g: GameOption) => void }) {
    const [search, setSearch] = useState("");
    // Visoria busca en su API (no hay listado): se pide al presionar Enter o Buscar.
    const [visoriaTerm, setVisoriaTerm] = useState("");
    const isVisoria = provider === "visoria";
    const { data: games = [], isLoading, isFetching, isError } = useQuery<GameOption[]>({
        queryKey: ["direct-topup-games", provider, isVisoria ? visoriaTerm : ""],
        queryFn: async () => provider === "coda"
            ? (await fetchCodaProducts()).map(g => ({ name: g.name, ref: g.apiPath, subtype: g.subtype, haveRole: g.haveRole }))
            : provider === "visoria"
                ? (await fetchVisoriaGames(visoriaTerm)).map(g => ({ name: g.name, ref: g.name, subtype: null, haveRole: false }))
                : (await fetchHankgamesCategories()).map(c => ({ name: c.name, ref: String(c.categoryId), subtype: null, haveRole: false })),
        enabled: !isVisoria || visoriaTerm.length >= 2,
        staleTime: 60_000,
    });
    const searchVisoria = () => setVisoriaTerm(search.trim());

    const filtered = useMemo(() => {
        if (isVisoria || !search.trim()) return games;
        const q = search.toLowerCase();
        return games.filter(g => g.name.toLowerCase().includes(q));
    }, [games, search]);

    return (
        <>
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={search} onChange={e => setSearch(e.target.value)} autoFocus
                    onKeyDown={e => { if (isVisoria && e.key === "Enter") searchVisoria(); }}
                    placeholder={isVisoria ? "Busca el juego en Visoria y presiona Enter" : "ej: Mobile Legends, Free Fire..."}
                    className={cn("pl-8 h-9 bg-secondary/40 border-border", isVisoria && "pr-20")} />
                {isVisoria && (
                    <Button size="sm" variant="outline" className="absolute right-1 top-1/2 -translate-y-1/2 h-7 text-xs border-border"
                        disabled={search.trim().length < 2} onClick={searchVisoria}>
                        Buscar
                    </Button>
                )}
            </div>
            <div className="border border-border rounded-lg divide-y divide-border flex-1 min-h-[220px] max-h-[320px] overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
                {isVisoria && visoriaTerm.length < 2 ? (
                    <p className="p-4 text-xs text-muted-foreground text-center">
                        Escribe el nombre del juego (ej: Mobile Legends) y presiona Buscar.
                    </p>
                ) : isLoading || (isVisoria && isFetching) ? (
                    <div className="p-3 space-y-2">
                        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="cv-skeleton h-10 rounded-lg" />)}
                    </div>
                ) : isError ? (
                    <p className="p-4 text-xs text-muted-foreground">
                        No se pudo cargar la lista de juegos de {PROVIDER_LABEL[provider]}. Verifica que yape-gaming esté accesible.
                    </p>
                ) : filtered.length === 0 ? (
                    <p className="p-4 text-xs text-muted-foreground text-center">
                        {provider === "coda"
                            ? "Sin resultados. Solo aparecen juegos con tipo \"topup\" del catálogo de Coda."
                            : provider === "visoria"
                                ? "Visoria no tiene productos de recarga que coincidan con esa búsqueda."
                                : "Sin resultados en las categorías de Hankgames."}
                    </p>
                ) : (
                    filtered.map(g => (
                        <button key={g.ref}
                            onClick={() => onSelect(g)}
                            className="w-full text-left px-4 py-2.5 hover:bg-secondary/30 transition-colors flex items-center justify-between gap-3"
                        >
                            <p className="text-xs font-medium truncate flex-1 min-w-0">{g.name}</p>
                            <div className="flex items-center gap-2 shrink-0">
                                {g.subtype != null && (
                                    <Badge variant="outline" className="text-[10px] text-muted-foreground border-border whitespace-nowrap">
                                        {subtypeText(g.subtype, g.haveRole)}
                                    </Badge>
                                )}
                                {!isVisoria && <span className="text-[10px] font-mono text-muted-foreground">{g.ref}</span>}
                            </div>
                        </button>
                    ))
                )}
            </div>
        </>
    );
}

function SkuStep({ provider, gameRef, selected, onSelect }: {
    provider: DirectTopupProvider; gameRef: string; selected: CodaSkuEntry | null; onSelect: (s: CodaSkuEntry) => void;
}) {
    const [search, setSearch] = useState("");
    const { data: skus = [], isLoading, isError } = useQuery<CodaSkuEntry[]>({
        queryKey: ["direct-topup-skus", provider, gameRef],
        queryFn: () => provider === "coda" ? fetchCodaProductSkus(gameRef)
            : provider === "visoria" ? fetchVisoriaGameProducts(gameRef)
                : fetchHankgamesCategoryProducts(gameRef),
    });

    const filtered = useMemo(() => {
        if (!search.trim()) return skus;
        const q = search.toLowerCase();
        return skus.filter(s =>
            s.title.toLowerCase().includes(q) ||
            String(s.sku).toLowerCase().includes(q) ||
            (s.priceCurrency ?? "").toLowerCase().includes(q)
        );
    }, [skus, search]);

    return (
        <>
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={search} onChange={e => setSearch(e.target.value)} autoFocus
                    placeholder="ej: 100, Diamantes, PEN..." className="pl-8 h-9 bg-secondary/40 border-border" />
            </div>
            <div className="border border-border rounded-lg divide-y divide-border flex-1 min-h-[180px] max-h-[280px] overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
                {isLoading ? (
                    <div className="p-3 space-y-2">
                        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="cv-skeleton h-10 rounded-lg" />)}
                    </div>
                ) : isError ? (
                    <p className="p-4 text-xs text-muted-foreground">No se pudieron cargar los SKUs de este juego. Intenta de nuevo.</p>
                ) : filtered.length === 0 ? (
                    <p className="p-4 text-xs text-muted-foreground text-center">Sin resultados para esa búsqueda.</p>
                ) : (
                    filtered.map((sku, i) => {
                        const isSelected = selected?.sku === sku.sku;
                        return (
                            <button key={`${sku.sku}-${i}`}
                                onClick={() => onSelect(sku)}
                                className={cn(
                                    "w-full text-left px-4 py-2.5 hover:bg-secondary/30 transition-colors flex items-center justify-between gap-3",
                                    isSelected && "bg-primary/10"
                                )}
                            >
                                <div className="min-w-0">
                                    <p className="text-xs font-medium truncate">{sku.title}</p>
                                    <p className="text-[10px] font-mono text-muted-foreground">{sku.sku}</p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    {sku.priceAmount != null && (
                                        <span className="text-[10px] font-mono text-muted-foreground">
                                            {sku.priceAmount} {sku.priceCurrency}
                                        </span>
                                    )}
                                    <Badge variant="outline" className={cn("text-[10px]", sku.stock ? "text-green-400 border-green-400/30" : "text-red-400 border-red-400/30")}>
                                        {sku.stock ? "Con stock" : "Sin stock"}
                                    </Badge>
                                    {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                                </div>
                            </button>
                        );
                    })
                )}
            </div>
        </>
    );
}

// "Usar para validar": apagado = el motor no le pide el nombre del jugador a
// esta variante (ese proveedor no valida este juego), pero sí recarga con ella.
function ValidatesSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-secondary/20 p-3">
            <div className="space-y-0.5">
                <Label htmlFor="variant-validates" className="text-xs font-medium">Usar para validar la cuenta</Label>
                <p className="text-[10px] text-muted-foreground">
                    Apágalo si este proveedor no devuelve el nombre del jugador en este juego. La variante se sigue usando para recargar.
                </p>
            </div>
            <Switch id="variant-validates" checked={checked} onCheckedChange={onChange} />
        </div>
    );
}

// Selector "Es respaldo de": une la variante a la recarga equivalente de otro proveedor.
function BackupSelect({ variants, value, onChange, excludeId }: {
    variants: DirectTopupVariant[]; value: string; onChange: (key: string) => void; excludeId?: number;
}) {
    // Una opción por grupo (no por variante), con los proveedores que ya tiene.
    const groups = useMemo(() => {
        const map = new Map<string, DirectTopupVariant[]>();
        for (const v of variants) {
            if (v.id === excludeId) continue;
            const k = groupKeyOf(v);
            map.set(k, [...(map.get(k) ?? []), v]);
        }
        return [...map.entries()].map(([key, members]) => ({ key, members }));
    }, [variants, excludeId]);

    return (
        <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Es respaldo de (opcional)</Label>
            <select value={value} onChange={e => onChange(e.target.value)}
                className="w-full h-9 rounded-md border border-border bg-secondary/40 px-3 text-xs">
                <option value="">Ninguna — va sola</option>
                {groups.map(g => (
                    <option key={g.key} value={g.key}>
                        {variantName(g.members[0])} ({g.members.map(m => PROVIDER_LABEL[providerOf(m)] ?? providerOf(m)).join(" + ")})
                    </option>
                ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
                Elige la misma recarga en el otro proveedor (ej. los mismos 100 diamantes). Se recarga primero con la más barata; si la rechaza, con la siguiente.
            </p>
        </div>
    );
}

export function TabProveedorCoda({ product }: { product: Product }) {
    const qc = useQueryClient();
    const [showModal, setShowModal] = useState(false);
    const [editingVariant, setEditingVariant] = useState<DirectTopupVariant | null>(null);
    const [provider, setProvider] = useState<DirectTopupProvider>("coda");
    const [selectedGame, setSelectedGame] = useState<GameOption | null>(null);
    const [selectedSku, setSelectedSku] = useState<CodaSkuEntry | null>(null);
    const [manualSubtype, setManualSubtype] = useState<number | null>(null);
    const [variantLabel, setVariantLabel] = useState("");
    const [backupOf, setBackupOf] = useState("");
    const [validates, setValidates] = useState(true);

    const invalidate = () => qc.invalidateQueries({ queryKey: ["direct-topup-variants", product.id] });

    const { data: variants = [], isLoading: loadingVariants } = useQuery({
        queryKey: ["direct-topup-variants", product.id],
        queryFn: () => fetchDirectTopupVariants(product.id),
    });

    // Variantes agrupadas por denominación, cada grupo en orden de prioridad.
    const groups = useMemo(() => {
        const map = new Map<string, DirectTopupVariant[]>();
        for (const v of variants) {
            const k = groupKeyOf(v);
            map.set(k, [...(map.get(k) ?? []), v]);
        }
        return [...map.entries()].map(([key, members]) => ({
            key,
            members: [...members].sort((a, b) => ((a.priority ?? 1) - (b.priority ?? 1)) || a.id - b.id),
        }));
    }, [variants]);

    const effectiveSubtype = selectedGame?.subtype ?? manualSubtype;

    function openAddModal() {
        setEditingVariant(null);
        setProvider("coda");
        setSelectedGame(null);
        setSelectedSku(null);
        setManualSubtype(null);
        setVariantLabel("");
        setBackupOf("");
        setValidates(true);
        setShowModal(true);
    }

    function openEdit(v: DirectTopupVariant) {
        // Editar permite renombrar y cambiar el respaldo. Para remapearla a
        // otro SKU, mejor borrarla y crear una nueva (evita dejar canales
        // apuntando a un SKU a medio cambiar).
        setEditingVariant(v);
        setVariantLabel(v.variant_label ?? "");
        const inGroup = variants.some(o => o.id !== v.id && groupKeyOf(o) === groupKeyOf(v));
        setBackupOf(inGroup ? groupKeyOf(v) : "");
        setValidates(v.validates !== false);
        setSelectedGame(null);
        setSelectedSku(null);
        setShowModal(true);
    }

    function goBack() {
        setSelectedGame(null);
        setSelectedSku(null);
        setManualSubtype(null);
    }

    // Prepara la unión a un grupo: si la variante de destino todavía no tiene
    // variant_key, se le pone uno ("g<id>") para que las dos lo compartan.
    async function joinGroup(groupKey: string, subtype: number | null | undefined, selfId?: number) {
        const members = variants.filter(v => groupKeyOf(v) === groupKey && v.id !== selfId);
        if (members.length === 0) throw new Error("La variante elegida ya no existe.");
        if (subtype != null && members.some(m => m.subtype !== subtype)) {
            throw new Error(`No se puede: la variante elegida pide ${subtypeText(members[0].subtype)} y esta ${subtypeText(subtype)}. Tienen que pedir los mismos datos.`);
        }
        let key = members[0].variant_key;
        if (!key) {
            key = `g${members[0].id}`;
            await apiUpdateDirectTopupVariant(product.id, members[0].id, { variant_key: key, priority: 1 });
        }
        const priority = Math.max(...members.map(m => m.priority ?? 1)) + 1;
        return { variant_key: key, priority };
    }

    const addMutation = useMutation({
        mutationFn: async () => {
            const group = backupOf ? await joinGroup(backupOf, effectiveSubtype) : { variant_key: null, priority: 1 };
            return apiAddDirectTopupVariant(product.id, {
                provider,
                coda_sku: String(selectedSku!.sku),
                coda_api_path: selectedGame!.ref,
                subtype: effectiveSubtype!,
                have_role: false,
                title: `${selectedGame!.name} - ${selectedSku!.title}`,
                variant_label: variantLabel.trim() || null,
                cost_price: selectedSku!.priceAmount,
                cost_currency: selectedSku!.priceCurrency ?? "USD",
                validates: CAN_VALIDATE.has(provider) && validates,
                ...group,
            });
        },
        onSuccess: () => {
            toast.success(backupOf ? "Variante agregada como respaldo" : "Variante agregada");
            invalidate();
            setShowModal(false);
        },
        onError: (e: Error) => { toast.error(e.message); invalidate(); },
    });

    const editMutation = useMutation({
        mutationFn: async () => {
            const v = editingVariant!;
            const body: Record<string, unknown> = { variant_label: variantLabel.trim() || null };
            if (CAN_VALIDATE.has(providerOf(v))) body.validates = validates;
            const currentlyGrouped = variants.some(o => o.id !== v.id && groupKeyOf(o) === groupKeyOf(v));
            const currentKey = currentlyGrouped ? groupKeyOf(v) : "";
            if (backupOf !== currentKey) {
                Object.assign(body, backupOf ? await joinGroup(backupOf, v.subtype, v.id) : { variant_key: "", priority: 1 });
            }
            return apiUpdateDirectTopupVariant(product.id, v.id, body);
        },
        onSuccess: () => {
            toast.success("Variante actualizada");
            invalidate();
            setShowModal(false);
            setEditingVariant(null);
        },
        onError: (e: Error) => { toast.error(e.message); invalidate(); },
    });

    // Mueve una variante dentro de su grupo y renumera las prioridades 1..n.
    const reorderMutation = useMutation({
        mutationFn: async ({ members, index, dir }: { members: DirectTopupVariant[]; index: number; dir: -1 | 1 }) => {
            const order = [...members];
            [order[index], order[index + dir]] = [order[index + dir], order[index]];
            await Promise.all(order.map((m, i) =>
                (m.priority ?? 1) === i + 1 ? null : apiUpdateDirectTopupVariant(product.id, m.id, { priority: i + 1 })));
        },
        onSuccess: () => invalidate(),
        onError: (e: Error) => { toast.error(e.message); invalidate(); },
    });

    const deleteMutation = useMutation({
        mutationFn: (variantId: number) => apiDeleteDirectTopupVariant(product.id, variantId),
        onSuccess: () => {
            toast.success("Variante eliminada (y sus canales)");
            invalidate();
        },
        onError: (e: Error) => toast.error(e.message),
    });

    const syncPriceMutation = useMutation({
        mutationFn: (variantId: number) => apiSyncDirectTopupVariantPrice(product.id, variantId),
        onSuccess: (res: { changed: boolean; new_price: number; currency: string }) => {
            toast.success(res.changed ? `Precio actualizado: ${res.new_price} ${res.currency}` : "El precio ya estaba al día");
            invalidate();
        },
        onError: (e: Error) => toast.error(e.message),
    });

    if (loadingVariants) {
        return <div className="cv-skeleton h-20 rounded-lg" />;
    }

    function VariantRow({ v, position, members }: { v: DirectTopupVariant; position?: number; members?: DirectTopupVariant[] }) {
        const isGroup = members && members.length > 1;
        return (
            <div className={cn("px-4 py-3 flex items-center justify-between gap-4",
                !isGroup && "rounded-lg border border-border bg-secondary/20")}>
                <div className="flex items-center gap-3 min-w-0">
                    {isGroup ? (
                        <div className="h-8 w-8 rounded-md bg-secondary/60 flex items-center justify-center shrink-0 text-xs font-bold text-muted-foreground">
                            {position! + 1}º
                        </div>
                    ) : (
                        <div className="h-8 w-8 rounded-md bg-primary/15 flex items-center justify-center shrink-0">
                            <Gamepad2 className="h-4 w-4 text-primary" />
                        </div>
                    )}
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                            <p className="text-sm font-medium truncate">{variantName(v)}</p>
                            <ProviderBadge provider={providerOf(v)} />
                            {validatesOf(v) ? (
                                <span className="flex items-center gap-1 text-[10px] text-green-400 whitespace-nowrap" title="Se le pide el nombre del jugador al validar">
                                    <ShieldCheck className="h-3 w-3" /> Valida
                                </span>
                            ) : (
                                <span className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap" title="No se usa para validar, solo para recargar">
                                    <Zap className="h-3 w-3" /> Solo recarga
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                            <span className="font-mono truncate">{v.coda_sku}</span>
                            <span>·</span><span className="whitespace-nowrap">{subtypeText(v.subtype, v.have_role)}</span>
                            {v.cost_price != null && <><span>·</span><span className="whitespace-nowrap">Costo {v.cost_price} {v.cost_currency}</span></>}
                        </div>
                        {!isGroup && !validatesOf(v) && (
                            <p className="text-[11px] text-amber-400 mt-1">
                                Sola no se puede validar la cuenta. Ponla como respaldo de esta misma recarga en Coda o Hankgames.
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {isGroup && (
                        <>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                disabled={position === 0 || reorderMutation.isPending} title="Subir en el orden de validación"
                                onClick={() => reorderMutation.mutate({ members: members!, index: position!, dir: -1 })}>
                                <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                disabled={position === members!.length - 1 || reorderMutation.isPending} title="Bajar en el orden de validación"
                                onClick={() => reorderMutation.mutate({ members: members!, index: position!, dir: 1 })}>
                                <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                        </>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={() => syncPriceMutation.mutate(v.id)} disabled={syncPriceMutation.isPending} title="Refrescar precio desde el proveedor">
                        {syncPriceMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => openEdit(v)} title="Renombrar o cambiar respaldo">
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteMutation.mutate(v.id)} disabled={deleteMutation.isPending} title="Quitar variante">
                        {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                </div>
            </div>
        );
    }

    const canSave = !!selectedSku && effectiveSubtype != null && !addMutation.isPending;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Variantes ({variants.length})
                </p>
                <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={openAddModal}>
                    <Plus className="h-3.5 w-3.5" /> Agregar variante
                </Button>
            </div>

            {variants.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                    <Gamepad2 className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-40" />
                    <p className="text-xs text-muted-foreground">Este producto todavía no tiene ninguna variante mapeada a un proveedor.</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {groups.map(({ key, members }) => members.length === 1 ? (
                        <VariantRow key={key} v={members[0]} />
                    ) : (
                        <div key={key} className="rounded-lg border border-border bg-secondary/20 divide-y divide-border">
                            <div className="px-4 py-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                                <Layers className="h-3.5 w-3.5" />
                                <span>
                                    Valida el primero de la lista que dé el nombre del jugador (las flechas cambian ese orden).
                                    Recarga del más barato al más caro; solo pasa al siguiente si el proveedor rechaza.
                                </span>
                            </div>
                            {(members[0].subtype === 2 || members.some(m => m.have_role))
                                && new Set(members.map(providerOf)).size > 1 && (
                                    <p className="px-4 py-2 text-[11px] text-amber-400">
                                        Este juego usa servidor o personaje: esos ids son de cada proveedor, así que el respaldo solo
                                        usa variantes del mismo proveedor que la primera.
                                    </p>
                                )}
                            {!members.some(validatesOf) && (
                                <p className="px-4 py-2 text-[11px] text-amber-400">
                                    Ninguna variante de este grupo valida la cuenta: agrega esta recarga en Coda o Hankgames, o activa "Usar para validar".
                                </p>
                            )}
                            {members.map((m, i) => <VariantRow key={m.id} v={m} position={i} members={members} />)}
                        </div>
                    ))}
                </div>
            )}

            <Dialog open={showModal} onOpenChange={setShowModal}>
                <DialogContent className="sm:max-w-[680px] bg-card border-border max-h-[90vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                            {selectedGame && (
                                <button onClick={goBack} className="hover:text-foreground">
                                    <ChevronLeft className="h-4 w-4" />
                                </button>
                            )}
                            {editingVariant ? "Editar variante" : selectedGame ? selectedGame.name : "Agregar variante"}
                        </DialogTitle>
                        <DialogDescription className="text-xs text-muted-foreground">
                            {editingVariant
                                ? "Cambia la etiqueta o el respaldo. Para remapearla a otro SKU, bórrala y crea una nueva."
                                : selectedGame
                                    ? `Elige el SKU (precio real de ${PROVIDER_LABEL[provider]}, en vivo).`
                                    : "Elige el proveedor y busca el juego en su catálogo."}
                        </DialogDescription>
                    </DialogHeader>

                    {editingVariant ? (
                        <div className="space-y-4 pt-1">
                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground">Etiqueta de la variante</Label>
                                <Input value={variantLabel} onChange={e => setVariantLabel(e.target.value)}
                                    placeholder="ej: 5 Diamantes" className="bg-secondary/40 border-border h-9" />
                            </div>
                            {CAN_VALIDATE.has(providerOf(editingVariant)) && <ValidatesSwitch checked={validates} onChange={setValidates} />}
                            <BackupSelect variants={variants} value={backupOf} onChange={setBackupOf} excludeId={editingVariant.id} />
                            <div className="flex gap-2 pt-1">
                                <Button variant="outline" className="flex-1 border-border" onClick={() => setShowModal(false)}>Cancelar</Button>
                                <Button className="flex-1 gap-2" disabled={editMutation.isPending} onClick={() => editMutation.mutate()}>
                                    {editMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                    Guardar
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3 pt-1 flex-1 min-h-0 flex flex-col overflow-y-auto">
                            {selectedGame === null ? (
                                <>
                                    <div className="grid grid-cols-3 gap-2">
                                        {PROVIDERS.map(p => (
                                            <Button key={p} variant={provider === p ? "default" : "outline"} size="sm"
                                                className={cn("h-8 text-xs", provider !== p && "border-border")}
                                                onClick={() => setProvider(p)}>
                                                {PROVIDER_LABEL[p]}
                                            </Button>
                                        ))}
                                    </div>
                                    <GameStep key={`game-step-${provider}`} provider={provider} onSelect={setSelectedGame} />
                                </>
                            ) : (
                                <>
                                    <SkuStep key={`sku-step-${provider}-${selectedGame.ref}`} provider={provider} gameRef={selectedGame.ref}
                                        selected={selectedSku} onSelect={sku => {
                                            setSelectedSku(sku);
                                            // Visoria dice qué datos pide cada producto: se sugiere, y se puede cambiar.
                                            const suggested = (sku as VisoriaSkuEntry).subtype;
                                            if (provider === "visoria" && suggested) setManualSubtype(suggested);
                                        }} />
                                    {selectedGame.subtype == null && (
                                        <div className="space-y-1.5">
                                            <Label className="text-xs text-muted-foreground">¿Qué datos pide este juego?</Label>
                                            <div className="grid grid-cols-3 gap-2">
                                                {[1, 2, 3].map(st => (
                                                    <Button key={st} variant={manualSubtype === st ? "default" : "outline"} size="sm"
                                                        className={cn("h-8 text-[11px]", manualSubtype !== st && "border-border")}
                                                        onClick={() => setManualSubtype(st)}>
                                                        {subtypeText(st)}
                                                    </Button>
                                                ))}
                                            </div>
                                            <p className="text-[10px] text-muted-foreground">
                                                {provider === "visoria"
                                                    ? "Sugerido según los campos que pide Visoria para este producto."
                                                    : "Hankgames no lo informa. Ej: Mobile Legends pide User ID + Zone ID; Free Fire solo User ID."}
                                            </p>
                                        </div>
                                    )}
                                    <div className="space-y-1.5">
                                        <Label className="text-xs text-muted-foreground">Etiqueta de la variante (opcional)</Label>
                                        <Input value={variantLabel} onChange={e => setVariantLabel(e.target.value)}
                                            placeholder="ej: 5 Diamantes" className="bg-secondary/40 border-border h-9" />
                                        <p className="text-[10px] text-muted-foreground">
                                            Te ayuda a diferenciar esta variante de otras del mismo producto. Si lo dejas vacío, se usa el título del proveedor.
                                        </p>
                                    </div>
                                    {CAN_VALIDATE.has(provider) ? <ValidatesSwitch checked={validates} onChange={setValidates} /> : (
                                        <p className="text-[11px] text-muted-foreground rounded-md border border-border bg-secondary/20 p-2">
                                            Visoria no valida cuentas: solo recarga. El nombre del jugador lo da Coda o Hankgames,
                                            así que agrégala como respaldo de la misma recarga en uno de ellos.
                                        </p>
                                    )}
                                    {variants.length > 0 && <BackupSelect variants={variants} value={backupOf} onChange={setBackupOf} />}
                                </>
                            )}

                            <div className="flex gap-2 pt-1">
                                <Button variant="outline" className="flex-1 border-border" onClick={() => setShowModal(false)}>Cancelar</Button>
                                <Button className="flex-1 gap-2" disabled={!canSave}
                                    onClick={() => canSave && addMutation.mutate()}>
                                    {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                    Guardar
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
