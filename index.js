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
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const page = await browser.newPage();
        page.setDefaultTimeout(120000);

        // Enable console logging from the page
        page.on('console', msg => console.log('PAGE:', msg.text()));

        // Variables to track Photopea state
        let photopeaReady = false;
        let fileLoaded = false;
        let psdData = null;

        // Expose functions that Photopea page can call back to Node.js
        await page.exposeFunction('__ppReady', () => {
            console.log('✅ Photopea ready signal received via exposeFunction');
            photopeaReady = true;
        });

        await page.exposeFunction('__ppFileLoaded', () => {
            console.log('✅ File loaded signal received via exposeFunction');
            fileLoaded = true;
        });

        await page.exposeFunction('__ppPsdData', (dataArray) => {
            console.log(`✅ PSD data received: ${dataArray.length} bytes`);
            psdData = Buffer.from(dataArray);
        });

        // Navigate to Photopea
        console.log('🌐 Loading Photopea...');
        await page.goto('https://www.photopea.com/', {
            waitUntil: 'networkidle2',
            timeout: 90000
        });

        // Set up message listener in page context to forward to our exposed functions
        console.log('⏳ Setting up message handlers...');
        await page.evaluate(() => {
            let readyReceived = false;
            let fileLoadedReceived = false;

            window.addEventListener('message', async function (e) {
                if (e.data === 'done') {
                    if (!readyReceived) {
                        readyReceived = true;
                        console.log('Photopea sent initial done');
                        window.__ppReady();
                    } else if (!fileLoadedReceived) {
                        fileLoadedReceived = true;
                        console.log('Photopea sent file loaded done');
                        window.__ppFileLoaded();
                    } else {
                        console.log('Photopea sent additional done (after export)');
                    }
                } else if (e.data instanceof ArrayBuffer) {
                    console.log('Received ArrayBuffer: ' + e.data.byteLength + ' bytes');
                    const arr = Array.from(new Uint8Array(e.data));
                    window.__ppPsdData(arr);
                } else if (typeof e.data === 'string') {
                    console.log('Photopea string message: ' + e.data.substring(0, 100));
                }
            });
        });

        // Wait for Photopea to be ready
        console.log('⏳ Waiting for Photopea to initialize...');
        await waitFor(() => photopeaReady, 60000, 'Photopea initialization');
        console.log('✅ Photopea is ready');

        // Send the .fig file
        console.log('📤 Sending .fig file to Photopea...');
        await page.evaluate((bufferArray) => {
            const uint8Array = new Uint8Array(bufferArray);
            window.postMessage(uint8Array.buffer, '*');
        }, Array.from(fileBuffer));

        // Wait for file to be loaded
        console.log('⏳ Waiting for file to load...');
        await waitFor(() => fileLoaded, 60000, 'File loading');
        console.log('✅ File loaded in Photopea');

        // Small delay for rendering
        await new Promise(r => setTimeout(r, 2000));

        // Request PSD export
        console.log('🔄 Requesting PSD export...');
        await page.evaluate(() => {
            window.postMessage('app.activeDocument.saveToOE("psd");', '*');
        });

        // Wait for PSD data
        console.log('⏳ Waiting for PSD data...');
        await waitFor(() => psdData !== null, 60000, 'PSD export');
        console.log(`✅ PSD received: ${psdData.length} bytes`);

        // Send PSD back to client
        res.set({
            'Content-Type': 'application/x-photoshop',
            'Content-Disposition': `attachment; filename="${fileName.replace('.fig', '.psd')}"`,
            'Content-Length': psdData.length
        });

        console.log(`✅ Sending PSD (${psdData.length} bytes) to client`);
        res.send(psdData);

    } catch (error) {
        console.error('❌ Conversion error:', error.message);
        res.status(500).json({
            error: 'Conversion failed',
            message: error.message
        });
    } finally {
        if (browser) {
            await browser.close();
            console.log('🔒 Browser closed');
        }
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
