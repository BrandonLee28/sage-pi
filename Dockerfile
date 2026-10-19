FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*
RUN ./node_modules/.bin/gws --version
COPY src ./src
COPY vendor ./vendor
COPY instructions ./instructions
COPY extensions ./extensions
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV DATA_DIR=/app/data
CMD ["node", "src/cli.ts"]
