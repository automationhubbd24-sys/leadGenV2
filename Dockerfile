# Build stage
FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# Skip chromium download to make install faster
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm install
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

# Install Chromium and its dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# Copy built files and dependencies
COPY --from=builder /app ./

EXPOSE 3000

# Start the application
CMD ["npx", "tsx", "server.ts"]
