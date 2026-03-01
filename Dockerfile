FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
COPY tools ./tools

RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/tools ./tools

EXPOSE 7071

CMD ["node", "dist/http.js"]

