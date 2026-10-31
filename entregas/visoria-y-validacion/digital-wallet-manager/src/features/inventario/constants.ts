// UBICACIÓN EN TU REPO: digital-wallet-manager/src/features/inventario/constants.ts
// (repositorio: digital-wallet-manager · ruta: src/features/inventario/constants.ts)
// ─── Constantes del módulo Inventario ──────────────────────────────────────────
// Movidas 1:1 desde pages/Inventario.tsx.
//
// Los colores/labels de canal (CHANNEL_COLORS, CHANNEL_LABEL, CHANNEL_COLORS_INFO)
// vivían acá duplicados — ahora salen de @/lib/channels, la fuente única
// compartida con el módulo Productos.

export const PROVIDER_NAMES: Record<number, string> = {
  1: "Bamboo",
  2: "EZ API",
  3: "99Cards",
  4: "WgCards",
  12: "Hankgames",
  13: "Coda",
  14: "Manastore",
  17: "Visoria",
};

export const PROVIDER_COLORS: Record<string, string> = {
  bamboo: "text-green-400 bg-green-500/10 border-green-500/20",
  ez: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
  "99cards": "text-pink-400 bg-pink-500/10 border-pink-500/20",
  wgcards: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
};
