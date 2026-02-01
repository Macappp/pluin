# Fig to PSD Conversion Server

Backend server for converting Figma .fig files to PSD using Photopea via Puppeteer.

## Setup

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

Server will run on `http://localhost:3000`

### API Endpoints

#### `GET /status`
Health check endpoint
```bash
curl http://localhost:3000/status
```

#### `POST /convert`
Convert .fig file to .psd
```bash
curl -X POST \
  http://localhost:3000/convert \
  -F "file=@yourfile.fig" \
  --output converted.psd
```

## Deploy to Railway

1. **Install Railway CLI** (optional):
```bash
npm i -g @railway/cli
```

2. **Deploy via GitHub** (recommended):
   - Push your code to GitHub
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect and deploy

3. **Deploy via CLI**:
```bash
railway login
railway init
railway up
```

4. **Get your deployment URL** from Railway dashboard

5. **Update your Figma plugin** with the Railway URL

## Environment Variables

Set these in Railway dashboard if needed:
- `PORT` - Auto-set by Railway
- `NODE_ENV` - Set to "production"

## Notes

- File size limit: 100MB
- Puppeteer runs in headless mode
- Each conversion opens a new browser instance
