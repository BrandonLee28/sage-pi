FROM node:24-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*
RUN ./node_modules/.bin/gws --version
COPY src ./src
COPY bin ./bin
RUN ln -s /app/bin/sage.mjs /usr/local/bin/sage
COPY vendor ./vendor
COPY instructions ./instructions
COPY extensions ./extensions
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV DATA_DIR=/app/data
ENV GATEWAY_HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8787)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/cli.ts", "gateway"]
