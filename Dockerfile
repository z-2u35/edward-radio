FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js README.md .env.example ./
COPY lavalink ./lavalink

CMD ["node", "index.js"]
