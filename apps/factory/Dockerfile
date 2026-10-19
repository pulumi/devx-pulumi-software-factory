# Mastra Factory, self-hosted. Build context: apps/factory
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
# git + build tools: the local sandbox clones repos and runs builds/tests.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=4111
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /workspaces && chown node:node /workspaces
USER node
EXPOSE 4111
CMD ["npm", "run", "start"]
