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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/main"]
