FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/agronomy/package.json packages/agronomy/
COPY packages/climate-core/package.json packages/climate-core/
COPY packages/weather-core/package.json packages/weather-core/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/api apps/api
COPY tsconfig.base.json ./

RUN pnpm --filter @agroclimate/contracts build \
  && pnpm --filter @agroclimate/agronomy build \
  && pnpm --filter @agroclimate/climate-core build \
  && pnpm --filter @agroclimate/weather-core build \
  && pnpm --filter @agroclimate/database build \
  && pnpm --filter @agroclimate/api build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/apps/api ./apps/api

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
