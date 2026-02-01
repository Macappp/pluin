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
        // Launch headless browser with Puppeteer
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

        // Navigate to Photopea
        console.log('🌐 Loading Photopea...');
        await page.goto('https://www.photopea.com/', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Wait for Photopea to be ready
        console.log('⏳ Waiting for Photopea to initialize...');
        await page.waitForFunction(() => {
            return typeof window.postMessage !== 'undefined';
        }, { timeout: 10000 });

        // Additional wait for Photopea's internal initialization
        await page.waitForTimeout(2000);

        // Send the .fig file to Photopea
        console.log('📤 Sending .fig file to Photopea...');
        await page.evaluate((buffer) => {
            const uint8Array = new Uint8Array(buffer);
            window.postMessage(uint8Array.buffer, '*');
        }, Array.from(fileBuffer));

        // Wait for file to load
        console.log('⏳ Waiting for file to load in Photopea...');
        await page.waitForTimeout(5000);

        // Request PSD export
        console.log('🔄 Requesting PSD export...');
        const psdBuffer = await page.evaluate(() => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for PSD export'));
                }, 30000);

                window.addEventListener('message', function handler(e) {
                    if (e.data instanceof ArrayBuffer) {
                        clearTimeout(timeout);
                        window.removeEventListener('message', handler);
                        // Convert ArrayBuffer to regular array for transfer
                        const uint8Array = new Uint8Array(e.data);
                        resolve(Array.from(uint8Array));
                    }
                });

                // Request PSD export
                window.postMessage('app.activeDocument.saveToOE("psd");', '*');
            });
        });

        console.log('✅ PSD received from Photopea');

        // Convert back to Buffer
        const psdBufferNode = Buffer.from(psdBuffer);

        // Send PSD back to client
        res.set({
            'Content-Type': 'application/x-photoshop',
            'Content-Disposition': `attachment; filename="${fileName.replace('.fig', '.psd')}"`,
            'Content-Length': psdBufferNode.length
        });

        console.log(`✅ Sending PSD (${psdBufferNode.length} bytes) to client`);
        res.send(psdBufferNode);

    } catch (error) {
        console.error('❌ Conversion error:', error);
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
