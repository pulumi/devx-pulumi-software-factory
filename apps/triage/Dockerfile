FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production
USER node
CMD ["npx", "tsx", "src/main.ts"]
