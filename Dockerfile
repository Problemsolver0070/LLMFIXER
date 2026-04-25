# Opto proxy - production image for Azure Container Apps
FROM node:20-slim

WORKDIR /usr/src/app

# Install production deps only (deterministic via package-lock.json)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run as non-root user (ships with node image)
USER node

CMD ["node", "index.js"]
