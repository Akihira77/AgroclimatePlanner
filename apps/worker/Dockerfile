FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/climate-core/package.json packages/climate-core/
COPY packages/weather-core/package.json packages/weather-core/
COPY packages/database/package.json packages/database/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/worker apps/worker
COPY tsconfig.base.json ./

RUN pnpm --filter @agroclimate/contracts build \
  && pnpm --filter @agroclimate/climate-core build \
  && pnpm --filter @agroclimate/weather-core build \
  && pnpm --filter @agroclimate/database build \
  && pnpm --filter @agroclimate/worker build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/apps/worker ./apps/worker

USER node
CMD ["node", "apps/worker/dist/main.js"]
