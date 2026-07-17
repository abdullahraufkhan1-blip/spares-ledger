# Spares Ledger — one-container deploy (Railway / Render / any Docker host)
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip build-essential \
    && pip3 install --break-system-packages pandas openpyxl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
