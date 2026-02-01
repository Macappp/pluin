FROM node:18-slim

# Install Chromium and necessary system libraries
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer environment variables to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy and install server dependencies
# Note: This Dockerfile is inside the server directory, so we copy locally
COPY package*.json ./
RUN npm install

# Copy server code
COPY . .

EXPOSE 3000

# Start the server
CMD ["node", "index.js"]
