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

# Copy everything needed to run
COPY --from=builder /app ./

EXPOSE 3000
ENV NODE_ENV=production

# Run with tsx to avoid build-server issues
CMD ["npx", "tsx", "server.ts"]
