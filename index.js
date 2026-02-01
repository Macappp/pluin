const express = require('express');
const cors = require('cors');
const multer = require('multer');
const puppeteer = require('puppeteer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
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
        page.setDefaultTimeout(90000);

        console.log('🌐 Loading Photopea...');
        await page.goto('https://www.photopea.com/', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Enable console logging
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));

        console.log('⏳ Waiting for Photopea to initialize...');
        
        // Wait for the initial "done" message from Photopea
        await page.evaluate(() => {
            return new Promise((resolve) => {
                const handler = (e) => {
                    if (e.data === 'done') {
                        console.log('✅ Photopea initialized (received "done")');
                        window.removeEventListener('message', handler);
                        resolve();
                    }
                };
                window.addEventListener('message', handler);
            });
        });

        console.log('✅ Photopea ready');

        // Send the .fig file to Photopea
        console.log('📤 Sending .fig file to Photopea...');
        await page.evaluate((buffer) => {
            const uint8Array = new Uint8Array(buffer);
            console.log('Sending ArrayBuffer:', uint8Array.byteLength, 'bytes');
            window.postMessage(uint8Array.buffer, '*');
        }, Array.from(fileBuffer));

        // Wait for "done" message after file is loaded
        console.log('⏳ Waiting for file to load...');
        await page.evaluate(() => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for file to load (60s)'));
                }, 60000);

                const handler = (e) => {
                    if (e.data === 'done') {
                        console.log('✅ File loaded (received "done")');
                        clearTimeout(timeout);
                        window.removeEventListener('message', handler);
                        resolve();
                    }
                };
                window.addEventListener('message', handler);
            });
        });

        console.log('✅ File loaded in Photopea');

        // Additional wait to ensure rendering is complete
        await new Promise(r => setTimeout(r, 2000));

        // Request PSD export
        console.log('🔄 Requesting PSD export...');
        const psdBuffer = await page.evaluate(() => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for PSD export (60s)'));
                }, 60000);

                let receivedArrayBuffer = false;

                const handler = (e) => {
                    // Photopea sends ArrayBuffer first, then "done"
                    if (e.data instanceof ArrayBuffer && !receivedArrayBuffer) {
                        console.log('📦 Received PSD ArrayBuffer:', e.data.byteLength, 'bytes');
                        receivedArrayBuffer = true;
                        
                        // Convert to array for transfer back to Node
                        const uint8Array = new Uint8Array(e.data);
                        const result = Array.from(uint8Array);
                        
                        // Wait for the "done" message to confirm completion
                        const doneHandler = (e2) => {
                            if (e2.data === 'done') {
                                console.log('✅ Export complete (received "done")');
                                clearTimeout(timeout);
                                window.removeEventListener('message', handler);
                                window.removeEventListener('message', doneHandler);
                                resolve(result);
                            }
                        };
                        window.addEventListener('message', doneHandler);
                        
                    } else if (typeof e.data === 'string') {
                        console.log('String message:', e.data);
                    }
                };

                window.addEventListener('message', handler);

                // Send the export command
                console.log('Sending export command: app.activeDocument.saveToOE("psd")');
                window.postMessage('app.activeDocument.saveToOE("psd")', '*');
            });
        });

        console.log('✅ PSD received from Photopea');

        // Convert back to Buffer
        const psdBufferNode = Buffer.from(psdBuffer);

        // Verify PSD header (should start with "8BPS")
        const header = psdBufferNode.slice(0, 4).toString();
        console.log('📄 File header:', header, header === '8BPS' ? '(valid PSD)' : '(WARNING: invalid PSD)');

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
        console.error('Stack trace:', error.stack);
        
        res.status(500).json({
            error: 'Conversion failed',
            message: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
