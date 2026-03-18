# Build stage
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --production

# Copy built assets and server
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/tsconfig.json ./

EXPOSE 3000
ENV NODE_ENV=production

CMD ["npx", "tsx", "server.ts"]
