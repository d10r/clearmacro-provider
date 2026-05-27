FROM node:24-bookworm-slim AS deps

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile \
  && pnpm store prune

COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config

USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
