# ---------- Etapa 1: compilar ----------
FROM node:22-slim AS build
WORKDIR /app

# La versión de pnpm coincide con "packageManager" de package.json.
RUN npm install -g pnpm@11.5.3

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN pnpm run build

# Deja solo las dependencias de producción para la imagen final.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod

# ---------- Etapa 2: imagen final ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# El usuario "node" ya viene en la imagen: no correr como root.
USER node
EXPOSE 3000

# Sin endpoint /health en la API: se comprueba que el puerto acepta conexiones.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('net').connect(process.env.PORT||3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main"]
