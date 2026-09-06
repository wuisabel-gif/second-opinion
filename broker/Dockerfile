FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.147.0

RUN npm install --global --no-audit --no-fund --ignore-scripts "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

WORKDIR /app
COPY broker/package.json broker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY broker/src ./src
COPY broker/migrations ./migrations

ENV NODE_ENV=production \
    PORT=3000 \
    CODEX_BIN=/usr/local/bin/codex

USER node
EXPOSE 3000

CMD ["node", "src/server.mjs"]
