import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { createClient } from "../api";
import type { DistClient, DistCredentials } from "../types";

const CURRENCIES = [
  { value: "USD", label: "USD · Dólares" },
  { value: "PEN", label: "PEN · Soles" },
];

const EMPTY = { code: "", name: "", currency: "USD", ips: "", rpm: "60", threshold: "", email: "", sandbox: false };

export function CreateClientDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (client: DistClient, credentials: DistCredentials) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const set = (k: Exclude<keyof typeof EMPTY, "sandbox">) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const mutation = useMutation({
    mutationFn: () => createClient({
      code: form.code.trim(),
      name: form.name.trim(),
      balance_currency: form.currency,
      ip_whitelist: form.ips.split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
      rate_limit_rpm: Number(form.rpm) || 60,
      low_balance_threshold: form.threshold ? Number(form.threshold) : null,
      contact_email: form.email.trim() || null,
      sandbox: form.sandbox,
    }),
    onSuccess: ({ client, credentials }) => {
      qc.invalidateQueries({ queryKey: ["dist", "clients"] });
      toast.success("Cliente creado");
      setForm(EMPTY);
      onCreated(client, credentials);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const codeValid = /^[a-z0-9_]{2,32}$/.test(form.code);
  const canSave = codeValid && form.name.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Nuevo cliente</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Al crearlo se generan sus credenciales de acceso a la API.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Código <span className="text-red-400">*</span></Label>
              <Input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toLowerCase() }))}
                placeholder="tisi" className="bg-secondary/40 border-border font-mono" autoFocus />
              {form.code && !codeValid && (
                <p className="text-[11px] text-red-400">Minúsculas, números y _ (2 a 32)</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Moneda del saldo <span className="text-red-400">*</span></Label>
              <Select value={form.currency} onValueChange={currency => setForm(f => ({ ...f, currency }))}>
                <SelectTrigger className="bg-secondary/40 border-border font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">No se puede cambiar después</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Nombre <span className="text-red-400">*</span></Label>
            <Input value={form.name} onChange={set("name")} placeholder="TISI SAC" className="bg-secondary/40 border-border" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">IPs autorizadas</Label>
            <Input value={form.ips} onChange={set("ips")} placeholder="200.1.2.3, 181.65.0.0/16"
              className="bg-secondary/40 border-border font-mono" />
            <p className="text-[11px] text-muted-foreground">Separadas por coma. Sin IPs, el cliente no puede entrar.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Peticiones por minuto</Label>
              <Input type="number" min="1" value={form.rpm} onChange={set("rpm")} className="bg-secondary/40 border-border font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Alerta de saldo bajo</Label>
              <Input type="number" min="0" step="0.01" value={form.threshold} onChange={set("threshold")}
                placeholder="Sin alerta" className="bg-secondary/40 border-border font-mono" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Email de contacto</Label>
            <Input type="email" value={form.email} onChange={set("email")} placeholder="ops@cliente.pe" className="bg-secondary/40 border-border" />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-secondary/20 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="dist-sandbox" className="text-xs font-medium">Cliente de prueba (sandbox)</Label>
              <p className="text-[11px] text-muted-foreground">
                Sus recargas son simuladas: no llegan a ningún proveedor ni al juego. El resultado depende del ID del jugador.
                No se puede cambiar después.
              </p>
            </div>
            <Switch id="dist-sandbox" checked={form.sandbox} onCheckedChange={sandbox => setForm(f => ({ ...f, sandbox }))} />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1 border-border" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button className="flex-1 gap-2" disabled={!canSave || mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Crear cliente
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
