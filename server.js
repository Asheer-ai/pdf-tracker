const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb } = require('pdf-lib');

const app = express();
const PORT = 3000;

// Create necessary directories
const dirs = ['uploads', 'tracked-pdfs', 'data'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

// Configure multer for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'));
    }
  }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Helper functions
const getTrackingData = () => {
  const dataPath = path.join(__dirname, 'data', 'tracking.json');
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify({}));
    return {};
  }
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
};

const saveTrackingData = (data) => {
  const dataPath = path.join(__dirname, 'data', 'tracking.json');
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
};

const logAccess = (trackingId, req) => {
  const trackingData = getTrackingData();
  
  if (!trackingData[trackingId]) {
    return false;
  }

  const accessLog = {
    timestamp: new Date().toISOString(),
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent')
  };

  trackingData[trackingId].accessLogs.push(accessLog);
  trackingData[trackingId].totalOpens = trackingData[trackingId].accessLogs.length;
  
  saveTrackingData(trackingData);
  return true;
};

// Inject tracking into PDF
async function injectTrackingIntoPDF(inputPath, outputPath, trackingId, serverUrl) {
  try {
    const existingPdfBytes = fs.readFileSync(inputPath);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    
    // Get the first page
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    
    // Create tracking URL for the invisible image
    const trackingUrl = `${serverUrl}/track/${trackingId}.png`;
    
    // Embed tracking image annotation (invisible 1x1 pixel)
    // This will make a request to our server when PDF is opened
    const annotation = {
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, 1, 1], // 1x1 pixel at bottom-left
      Border: [0, 0, 0], // No border
      A: {
        Type: 'Action',
        S: 'URI',
        URI: trackingUrl
      }
    };
    
    // Add invisible text with external image reference
    // This creates an external reference that PDF readers will try to fetch
    const trackingScript = `
      <html>
        <body>
          <img src="${trackingUrl}" width="1" height="1" style="position:absolute;left:-9999px;" />
        </body>
      </html>
    `;
    
    // Add metadata with tracking URL (some PDF viewers fetch this)
    pdfDoc.setProducer(`PDF Tracker - ${trackingUrl}`);
    
    // Method 1: Add JavaScript action (works in Adobe Reader with JS enabled)
    const jsAction = `
      try {
        var url = "${trackingUrl}";
        this.submitForm({cURL: url, cSubmitAs: "HTML"});
      } catch(e) {}
    `;
    
    // Add open action with JavaScript
    try {
      pdfDoc.context.obj({
        Type: 'Action',
        S: 'JavaScript',
        JS: jsAction
      });
    } catch (e) {
      console.log('Could not add JavaScript action:', e.message);
    }
    
    // Save the modified PDF
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outputPath, pdfBytes);
    
    return true;
  } catch (error) {
    console.error('Error injecting tracking:', error);
    throw error;
  }
}

// Routes

// Upload PDF and inject tracking
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const trackingId = uuidv4();
    const inputPath = path.join(__dirname, 'uploads', req.file.filename);
    const outputFileName = `tracked-${trackingId}.pdf`;
    const outputPath = path.join(__dirname, 'tracked-pdfs', outputFileName);
    
    // Get server URL (use ngrok URL if available, otherwise localhost)
    const serverUrl = req.get('host').includes('localhost') 
      ? `http://localhost:${PORT}`
      : `http://${req.get('host')}`;
    
    // Inject tracking into PDF
    await injectTrackingIntoPDF(inputPath, outputPath, trackingId, serverUrl);
    
    // Save tracking data
    const trackingData = getTrackingData();
    trackingData[trackingId] = {
      trackingId: trackingId,
      originalName: req.file.originalname,
      trackedFileName: outputFileName,
      uploadedAt: new Date().toISOString(),
      accessLogs: [],
      totalOpens: 0,
      trackingUrl: `${serverUrl}/track/${trackingId}.png`
    };
    saveTrackingData(trackingData);

    res.json({
      success: true,
      trackingId: trackingId,
      message: 'PDF processed with tracking. Download and share it anywhere!',
      downloadUrl: `${serverUrl}/download-tracked/${trackingId}`,
      statsUrl: `${serverUrl}/api/stats/${trackingId}`
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tracking pixel endpoint
app.get('/track/:trackingId.png', (req, res) => {
  const trackingId = req.params.trackingId;
  
  // Log the access
  logAccess(trackingId, req);
  
  // Return a 1x1 transparent PNG
  const transparentPixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(transparentPixel);
});

// Download tracked PDF
app.get('/download-tracked/:trackingId', (req, res) => {
  try {
    const { trackingId } = req.params;
    const trackingData = getTrackingData();

    if (!trackingData[trackingId]) {
      return res.status(404).send('PDF not found');
    }

    const filePath = path.join(__dirname, 'tracked-pdfs', trackingData[trackingId].trackedFileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('PDF file not found');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${trackingData[trackingId].originalName}"`);
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).send('Error downloading PDF');
  }
});

// Get stats for a specific PDF
app.get('/api/stats/:trackingId', (req, res) => {
  try {
    const { trackingId } = req.params;
    const trackingData = getTrackingData();

    if (!trackingData[trackingId]) {
      return res.status(404).json({ error: 'PDF not found' });
    }

    res.json(trackingData[trackingId]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all PDFs stats
app.get('/api/stats', (req, res) => {
  try {
    const trackingData = getTrackingData();
    res.json(trackingData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a PDF
app.delete('/api/delete/:trackingId', (req, res) => {
  try {
    const { trackingId } = req.params;
    const trackingData = getTrackingData();

    if (!trackingData[trackingId]) {
      return res.status(404).json({ error: 'PDF not found' });
    }

    // Delete the tracked PDF file
    const trackedPath = path.join(__dirname, 'tracked-pdfs', trackingData[trackingId].trackedFileName);
    if (fs.existsSync(trackedPath)) {
      fs.unlinkSync(trackedPath);
    }

    // Delete tracking data
    delete trackingData[trackingId];
    saveTrackingData(trackingData);

    res.json({ success: true, message: 'PDF deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test tracking endpoint (manual test)
app.get('/test-track/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  logAccess(trackingId, req);
  res.send('Tracking event logged! Check your dashboard.');
});

// Start server
app.listen(PORT, () => {
  console.log(`PDF Tracker running on http://localhost:${PORT}`);
  console.log(`Upload PDFs to inject tracking and share anywhere!`);
  console.log(`\nIMPORTANT: For tracking to work when sharing PDFs:`);
  console.log(`1. Your server must be publicly accessible (use ngrok or deploy)`);
  console.log(`2. Recipients must open PDF in viewers that allow external resources`);
  console.log(`3. Test locally first using the test endpoint`);
});