FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
