const express = require('express');
const cors = require('cors');
const multer = require('multer');
const puppeteer = require('puppeteer');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Configure multer for file uploads (store in memory)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.fig')) {
            cb(null, true);
        } else {
            cb(new Error('Only .fig files are allowed'));
        }
    }
});

// Health check endpoint
app.get('/status', (req, res) => {
    res.json({ status: 'OK', message: 'Fig to PSD server running' });
});

// Main conversion endpoint
app.post('/convert', upload.single('file'), async (req, res) => {
    console.log('📥 Conversion request received');

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    console.log(`📁 File: ${fileName} (${fileBuffer.byteLength} bytes)`);

    let browser;
    try {
        console.log('🚀 Launching Puppeteer...');
        // Use standard launch
        browser = await puppeteer.launch({
            headless: 'new', // or true
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security', // Needed for cross-origin iframe interaction if we were doing it directly, still good to have
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const page = await browser.newPage();

        // Capture browser console logs
        page.on('console', msg => console.log('PAGE:', msg.text()));

        // Expose bindings for the wrapper to call
        let resolverReady;
        const readyPromise = new Promise(r => resolverReady = r);

        let resolverData;
        const dataPromise = new Promise(r => resolverData = r);

        await page.exposeFunction('onPhotopeaReady', () => {
            console.log('✅ Photopea Ready (callback from wrapper)');
            resolverReady();
        });

        await page.exposeFunction('onPhotopeaData', (data) => {
            console.log(`✅ Received Data: ${data ? data.length : 0} bytes`);
            resolverData(data);
        });

        // Navigate to our local wrapper
        // Ensure we are listening before navigating
        const localUrl = `http://localhost:${PORT}/wrapper.html`;
        console.log(`🌐 Navigating to ${localUrl}...`);

        await page.goto(localUrl, { waitUntil: 'networkidle0' });

        // Wait for Photopea 'done' message
        console.log('⏳ Waiting for Photopea initialization...');
        await readyPromise;

        // Send file
        console.log('📤 Sending file to Photopea...');
        // Pass buffer as array (Puppeteer serializes this)
        await page.evaluate((data) => {
            window.loadPhotopeaFile(data);
        }, Array.from(fileBuffer));

        // Wait a small amount of time for file processing (Photopea is fast but async)
        // We don't have a direct 'file loaded' signal from the wrapper yet unless we add one listening to 'opened' 
        // But usually 'done' is for init. Loading happens fast.
        // Let's rely on a delay or update wrapper to listen for 'fileOpened' if Photopea sends it?
        // Photopea sends 'done' only on init. 
        // It doesn't send a message when a file opens unless we script it.
        // But we are just sending the buffer.

        // Let's wait a safe margin
        await new Promise(r => setTimeout(r, 3000));

        // Script: save
        console.log('� Triggering Save...');
        await page.evaluate(() => {
            window.savePhotopeaFile('psd');
        });

        // Wait for data
        console.log('⏳ Waiting for PSD data back...');

        // Set a timeout for the data promise
        const data = await Promise.race([
            dataPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for PSD data')), 60000))
        ]);

        if (!data) throw new Error('Received empty data from Photopea');

        const psdBuffer = Buffer.from(data);

        console.log(`✅ Conversion complete. Sending ${psdBuffer.length} bytes to client.`);

        res.set({
            'Content-Type': 'application/x-photoshop',
            'Content-Disposition': `attachment; filename="${fileName.replace('.fig', '.psd')}"`,
            'Content-Length': psdBuffer.length
        });
        res.send(psdBuffer);

    } catch (error) {
        console.error('❌ Conversion error:', error);
        res.status(500).json({ error: 'Conversion failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// Helper function to wait for a condition
function waitFor(conditionFn, timeoutMs, description) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const checkInterval = setInterval(() => {
            if (conditionFn()) {
                clearInterval(checkInterval);
                resolve();
            } else if (Date.now() - startTime > timeoutMs) {
                clearInterval(checkInterval);
                reject(new Error(`Timeout waiting for: ${description}`));
            }
        }, 500);
    });
}

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/status`);
    console.log(`📍 Convert endpoint: http://localhost:${PORT}/convert`);
});
