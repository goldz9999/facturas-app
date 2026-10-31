import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Building2, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { daysLabel, DIST_API_URL, getSummary, listClients, money } from "./api";
import {
  CLIENT_STATUS, CLIENT_TABS, clientHealth, HEALTH_COLOR, HEALTH_DOT,
  type ClientSummary, type ClientTab, type DistClient, type DistCredentials,
} from "./types";
import { CreateClientDialog } from "./components/CreateClientDialog";
import { CredentialsDialog } from "./components/CredentialsDialog";
import { BalanceDialog } from "./components/BalanceDialog";
import { ClientResumen } from "./components/ClientResumen";
import { ClientOrdenes } from "./components/ClientOrdenes";
import { ClientRecargas } from "./components/ClientRecargas";
import { ClientSaldo } from "./components/ClientSaldo";
import { ClientProductos } from "./components/ClientProductos";
import { ClientAcceso } from "./components/ClientAcceso";
import { RowsSkeleton } from "./components/RowsSkeleton";

/** Totales por moneda: los saldos no se suman entre monedas distintas. */
function totalsByCurrency(clients: DistClient[]) {
  const t = new Map<string, number>();
  for (const c of clients) t.set(c.balance_currency, (t.get(c.balance_currency) ?? 0) + Number(c.balance));
  return [...t.entries()];
}

export default function DistribucionPage() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<ClientTab>("Resumen");
  const [creating, setCreating] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [newCreds, setNewCreds] = useState<{ name: string; credentials: DistCredentials } | null>(null);

  const clientsQ = useQuery<DistClient[]>({ queryKey: ["dist", "clients"], queryFn: listClients, enabled: !!DIST_API_URL, staleTime: 15_000 });
  const summaryQ = useQuery<ClientSummary[]>({ queryKey: ["dist", "summary"], queryFn: getSummary, enabled: !!DIST_API_URL, staleTime: 30_000 });
  const clients = useMemo(() => clientsQ.data ?? [], [clientsQ.data]);
  const summary = useMemo(() => new Map((summaryQ.data ?? []).map(s => [s.client_id, s])), [summaryQ.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? clients.filter(c => c.name.toLowerCase().includes(q) || c.code.includes(q)) : clients;
  }, [clients, search]);

  // En escritorio, con un solo cliente (o al entrar) se abre el primero: nunca una mitad vacía.
  const effectiveId = selectedId ?? (typeof window !== "undefined" && window.innerWidth >= 640 ? clients[0]?.id ?? null : null);
  const selected = clients.find(c => c.id === effectiveId) ?? null;
  const sel = selected ? summary.get(selected.id) : undefined;
  const salesToday = (summaryQ.data ?? []).reduce((a, s) => a + s.codes_today, 0);

  if (!DIST_API_URL) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-6">
        <div className="max-w-md text-center space-y-2">
          <AlertTriangle className="h-8 w-8 mx-auto text-yellow-400" />
          <p className="font-semibold">Falta configurar la API de distribución</p>
          <p className="text-sm text-muted-foreground">
            Agrega <code className="font-mono">VITE_DIST_API_URL</code> en el .env del frontend (y en Vercel) con la URL de schedaup-api y vuelve a desplegar.
          </p>
        </div>
      </div>
    );
  }

  const selectClient = (id: number) => { setSelectedId(id); setTab("Resumen"); };

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden" style={{ animation: "cv-fade-up 0.32s ease both" }}>
      {/* ── Lista ─────────────────────────────────────────────────────── */}
      <aside className={cn("w-full sm:w-72 shrink-0 border-r border-border flex flex-col bg-card/50", selectedId && "hidden sm:flex")}>
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            <h1 className="text-sm font-bold">Clientes <span className="text-muted-foreground font-medium">{clients.length || ""}</span></h1>
            <Button size="icon" className="ml-auto h-7 w-7 active:scale-[0.97] transition-transform" title="Nuevo cliente" aria-label="Nuevo cliente" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {clients.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] text-muted-foreground">Saldos prepago</p>
                {totalsByCurrency(clients).map(([cur, v]) => (
                  <p key={cur} className="font-mono text-sm font-semibold leading-snug">{money(v)} <span className="text-[10px] text-muted-foreground">{cur}</span></p>
                ))}
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Ventas hoy</p>
                <p className="font-mono text-sm font-semibold">{summaryQ.isLoading ? "—" : salesToday} <span className="text-[10px] text-muted-foreground">códigos</span></p>
              </div>
            </div>
          )}
          {clients.length > 6 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente" className="pl-8 bg-secondary/40 border-border h-9" />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {clientsQ.isLoading ? <div className="p-3"><RowsSkeleton rows={3} className="h-14" /></div> : clientsQ.error ? (
            <p className="p-4 text-sm text-red-400">{(clientsQ.error as Error).message}</p>
          ) : filtered.map(c => {
            const health = clientHealth(c, summary.get(c.id));
            const dot = HEALTH_DOT[health];
            return (
              <button key={c.id} onClick={() => selectClient(c.id)}
                className={cn("w-full text-left px-4 py-3 border-b border-border/60 hover:bg-secondary/30 transition-colors",
                  effectiveId === c.id && "bg-secondary/60")}>
                <div className="flex items-center gap-2">
                  <p className={cn("text-sm truncate flex-1", effectiveId === c.id ? "font-semibold" : "font-medium")}>{c.name}</p>
                  {c.sandbox && <SandboxBadge />}
                  {dot && <span className={cn("h-2 w-2 rounded-full shrink-0", dot)} title={health === "off" ? CLIENT_STATUS[c.status].label : health === "empty" ? "Sin saldo" : "Saldo bajo"} />}
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[11px] text-muted-foreground font-mono">{c.code}</span>
                  <span className={cn("text-xs font-mono", HEALTH_COLOR[health])}>{money(c.balance, c.balance_currency)}</span>
                </div>
              </button>
            );
          })}

          {!clientsQ.isLoading && clients.length <= 1 && (
            <div className="m-4 rounded-xl border border-dashed border-border p-4">
              <p className="text-sm font-semibold">{clients.length ? "Suma otro cliente" : "Crea tu primer cliente"}</p>
              <ol className="mt-2 mb-3 ml-4 list-decimal text-xs text-muted-foreground space-y-1">
                <li>Créalo y copia sus credenciales</li>
                <li>Agrega sus IPs autorizadas</li>
                <li>Asígnale productos en Productos → Canales</li>
                <li>Carga su saldo</li>
              </ol>
              <Button variant="outline" size="sm" className="gap-1.5 border-border" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" /> Nuevo cliente
              </Button>
            </div>
          )}
        </div>
      </aside>

      {/* ── Detalle ───────────────────────────────────────────────────── */}
      {!selected ? (
        <div className="hidden sm:flex flex-1 items-center justify-center text-muted-foreground">
          <div className="text-center">
            <Building2 className="h-12 w-12 mx-auto mb-3 opacity-20" />
            <p className="text-sm">{clientsQ.isLoading ? "Cargando…" : "Crea un cliente para empezar"}</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          <header className="px-4 sm:px-6 pt-4 border-b border-border bg-card/30">
            <Button variant="ghost" size="sm" className="sm:hidden -ml-2 mb-2 h-7 gap-1.5 text-muted-foreground" onClick={() => setSelectedId(null)}>
              <ArrowLeft className="h-3.5 w-3.5" /> Clientes
            </Button>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold leading-tight truncate">{selected.name}</h2>
                  <Badge variant="outline" className={cn("text-[11px]", CLIENT_STATUS[selected.status].color)}>{CLIENT_STATUS[selected.status].label}</Badge>
                  {selected.sandbox && <SandboxBadge />}
                </div>
                <p className="text-xs text-muted-foreground font-mono mt-1">
                  {selected.code} · {selected.ip_whitelist.length} {selected.ip_whitelist.length === 1 ? "IP" : "IPs"}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-[11px] text-muted-foreground">
                    Saldo{daysLabel(sel?.days_left) ? ` · alcanza ${daysLabel(sel?.days_left)}` : ""}
                  </p>
                  <p className={cn("font-mono text-xl font-bold", HEALTH_COLOR[clientHealth(selected, sel)] === "text-muted-foreground" ? "" : HEALTH_COLOR[clientHealth(selected, sel)])}>
                    {money(selected.balance)} <span className="text-xs text-muted-foreground font-medium">{selected.balance_currency}</span>
                  </p>
                </div>
                <Button className="gap-1.5 active:scale-[0.97] transition-transform" onClick={() => setCrediting(true)}>
                  <Plus className="h-4 w-4" /> Cargar saldo
                </Button>
              </div>
            </div>
            <nav className="flex gap-5 mt-4 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-none" aria-label="Secciones del cliente">
              {CLIENT_TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} aria-current={tab === t ? "page" : undefined}
                  className={cn("pb-2.5 text-sm whitespace-nowrap shrink-0 border-b-2 transition-colors",
                    tab === t ? "border-primary text-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground")}>
                  {t}
                </button>
              ))}
            </nav>
          </header>
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            {tab === "Resumen" && <ClientResumen key={selected.id} client={selected} onSeeOrders={() => setTab("Órdenes")} />}
            {tab === "Órdenes" && <ClientOrdenes key={selected.id} client={selected} />}
            {tab === "Recargas" && <ClientRecargas key={selected.id} client={selected} />}
            {tab === "Movimientos" && <ClientSaldo key={selected.id} client={selected} />}
            {tab === "Productos" && <ClientProductos key={selected.id} client={selected} />}
            {tab === "Acceso API" && <ClientAcceso key={selected.id} client={selected} />}
          </div>
          <BalanceDialog client={selected} mode={crediting ? "credit" : null} onClose={() => setCrediting(false)} />
        </div>
      )}

      <CreateClientDialog open={creating} onOpenChange={setCreating}
        onCreated={(client, credentials) => {
          setCreating(false);
          setSelectedId(client.id);
          setTab("Acceso API");
          setNewCreds({ name: client.name, credentials });
        }} />
      <CredentialsDialog credentials={newCreds?.credentials ?? null} clientName={newCreds?.name ?? ""} onClose={() => setNewCreds(null)} />
    </div>
  );
}

function SandboxBadge() {
  return (
    <Badge variant="outline" className="text-[10px] shrink-0 border-violet-500/40 text-violet-400"
      title="Cliente de prueba: recargas simuladas">
      Prueba
    </Badge>
  );
}
