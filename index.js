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

        // Listen for console logs from the browser
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));

        // Create a wrapper HTML page with Photopea in an iframe
        // This is REQUIRED because Photopea's postMessage API is designed
        // for communication between parent window and iframe
        const wrapperHTML = `
        <!DOCTYPE html>
        <html>
        <head><title>Photopea Wrapper</title></head>
        <body style="margin:0;padding:0;overflow:hidden;">
            <iframe id="pp" src="https://www.photopea.com/" 
                    style="width:100%;height:100vh;border:none;"></iframe>
            <script>
                window.ppReady = false;
                window.psdData = null;
                window.ppError = null;
                window.messageLog = [];
                
                window.addEventListener('message', function(e) {
                    // Messages from Photopea iframe
                    if (e.data === 'done') {
                        console.log('Photopea: done signal received');
                        window.ppReady = true;
                        window.messageLog.push('done');
                    } else if (e.data instanceof ArrayBuffer) {
                        console.log('Photopea: ArrayBuffer received, size=' + e.data.byteLength);
                        window.psdData = e.data;
                        window.messageLog.push('arraybuffer:' + e.data.byteLength);
                    } else if (typeof e.data === 'string') {
                        console.log('Photopea message: ' + e.data);
                        window.messageLog.push('string:' + e.data.substring(0, 50));
                    }
                });
            </script>
        </body>
        </html>`;

        // Use data URL to load the wrapper page
        console.log('🌐 Loading Photopea wrapper page...');
        await page.goto(`data:text/html,${encodeURIComponent(wrapperHTML)}`, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        // Wait for Photopea to be fully loaded and send "done" signal
        console.log('⏳ Waiting for Photopea to initialize...');
        await page.waitForFunction(() => window.ppReady === true, {
            timeout: 60000,
            polling: 500
        });
        console.log('✅ Photopea is ready');

        // Send the .fig file to Photopea via the iframe's contentWindow
        console.log('� Sending .fig file to Photopea...');

        // Reset ready flag before sending file
        await page.evaluate(() => { window.ppReady = false; });

        await page.evaluate((bufferArray) => {
            const uint8Array = new Uint8Array(bufferArray);
            const iframe = document.getElementById('pp');
            iframe.contentWindow.postMessage(uint8Array.buffer, '*');
        }, Array.from(fileBuffer));

        // Wait for Photopea to process the file (sends "done" when complete)
        console.log('⏳ Waiting for file to load in Photopea...');
        await page.waitForFunction(() => window.ppReady === true, {
            timeout: 60000,
            polling: 1000
        });
        console.log('✅ File loaded in Photopea');

        // Add a small delay for rendering to complete
        await new Promise(r => setTimeout(r, 2000));

        // Reset flags before export
        await page.evaluate(() => {
            window.ppReady = false;
            window.psdData = null;
        });

        // Request PSD export
        console.log('🔄 Requesting PSD export...');
        await page.evaluate(() => {
            const iframe = document.getElementById('pp');
            iframe.contentWindow.postMessage('app.activeDocument.saveToOE("psd");', '*');
        });

        // Wait for PSD data to arrive
        console.log('⏳ Waiting for PSD data...');
        await page.waitForFunction(() => window.psdData !== null, {
            timeout: 60000,
            polling: 500
        });

        // Retrieve the PSD data
        const psdArray = await page.evaluate(() => {
            const data = window.psdData;
            return Array.from(new Uint8Array(data));
        });

        console.log('✅ PSD received from Photopea');

        // Convert back to Buffer
        const psdBufferNode = Buffer.from(psdArray);

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

        // Try to get debug info from the page
        try {
            if (browser) {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    const debugInfo = await pages[0].evaluate(() => {
                        return {
                            ppReady: window.ppReady,
                            psdDataSize: window.psdData ? window.psdData.byteLength : null,
                            messageLog: window.messageLog
                        };
                    }).catch(() => null);
                    console.log('Debug info:', debugInfo);
                }
            }
        } catch (debugError) {
            // Ignore debug errors
        }

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
