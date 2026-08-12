# Backend da PoC.
#
# Atenção ao passo de copiar as migrações: o tsc só emite TypeScript, então sem
# `npm run build` (que roda scripts/copy-migrations.mjs) a imagem subiria sem os
# .sql e falharia ao migrar. Bug que não aparece em dev, onde o tsx roda de src/.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# roda sem privilégio; a imagem node já traz o usuário `node`
USER node

EXPOSE 8787

# as migrações são aplicadas no boot (idempotentes, com advisory lock).
# Em pipeline que migra antes de trocar instâncias, rode `npm run db:migrate`
# como job separado e mantenha isto como rede de segurança.
CMD ["node", "dist/index.js"]
