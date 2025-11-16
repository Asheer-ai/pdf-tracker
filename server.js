const dotenv=require('dotenv')
dotenv.config()
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

const dirs = ['uploads', 'data'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

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

app.use(express.json());
app.use(express.static('public'));

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

const logAccess = (trackingId, action, req, metadata = {}) => {
  const trackingData = getTrackingData();
  
  if (!trackingData[trackingId]) {
    return false;
  }

  const accessLog = {
    timestamp: new Date().toISOString(),
    action: action,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    ...metadata
  };

  trackingData[trackingId].accessLogs.push(accessLog);
  
  if (action === 'view') {
    trackingData[trackingId].totalViews++;
  } else if (action === 'download') {
    trackingData[trackingId].totalDownloads++;
  }
  
  saveTrackingData(trackingData);
  return true;
};

app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const trackingId = uuidv4();
    const shortId = trackingId.split('-')[0]; 
    
    const protocol = req.get('host').includes('localhost') ? 'http' : 'https';
    const serverUrl = `${protocol}://${req.get('host')}`;
    
    const trackingData = getTrackingData();
    trackingData[trackingId] = {
      trackingId: trackingId,
      shortId: shortId,
      originalName: req.file.originalname,
      fileName: req.file.filename,
      uploadedAt: new Date().toISOString(),
      accessLogs: [],
      totalViews: 0,
      totalDownloads: 0,
      allowDownload: true,
      viewerUrl: `${serverUrl}/v/${shortId}`
    };
    saveTrackingData(trackingData);

    res.json({
      success: true,
      trackingId: trackingId,
      shortId: shortId,
      shareableLink: `${serverUrl}/v/${shortId}`,
      statsUrl: `${serverUrl}/api/stats/${trackingId}`,
      message: 'PDF uploaded successfully! Share the link below.'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/v/:shortId', (req, res) => {
  const { shortId } = req.params;
  const trackingData = getTrackingData();
  
  const trackingEntry = Object.entries(trackingData).find(([_, data]) => data.shortId === shortId);
  
  if (!trackingEntry) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Document Not Found</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container { text-align: center; }
          h1 { font-size: 48px; margin-bottom: 20px; }
          p { font-size: 18px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📄 404</h1>
          <p>Document not found or has been removed.</p>
        </div>
      </body>
      </html>
    `);
  }

  const [trackingId, pdfData] = trackingEntry;

  logAccess(trackingId, 'view', req);

  res.send(`
    <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pdfData.originalName}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf_viewer.min.css">
    
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
            /* This is the dark gray background from Chrome's viewer */
            background: #525659; 
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden; /* Prevent body scroll */
        }

        /* === TOOLBAR (Chrome Style) === */
        .toolbar {
            background: #333;
            color: #fff;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
            padding: 8px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            height: 56px;
            flex-shrink: 0; /* Prevent toolbar from shrinking */
            z-index: 100;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* Group 1: Filename */
        .toolbar-group.left {
            flex: 1;
            min-width: 100px;
        }
        .doc-title {
            font-size: 15px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        /* Group 2: Page & Zoom Controls */
        .toolbar-group.center {
            flex: 0 1 auto;
            justify-content: center;
        }

        /* Group 3: Actions */
        .toolbar-group.right {
            flex: 1;
            justify-content: flex-end;
            min-width: 100px;
        }
        
        /* Buttons */
        .toolbar-btn {
            background: transparent;
            border: none;
            color: #fff;
            padding: 6px;
            cursor: pointer;
            border-radius: 4px;
            width: 32px;
            height: 32px;
            font-size: 20px;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
        }
        
        .toolbar-btn:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.15);
        }

        .toolbar-btn:active:not(:disabled) {
            background: rgba(255, 255, 255, 0.3);
        }

        .toolbar-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* Page Info */
        .page-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 4px;
            padding: 0 8px;
            height: 32px;
        }
        .page-info {
            font-size: 14px;
            color: #fff;
            white-space: nowrap;
        }

        /* Separator */
        .separator {
            width: 1px;
            height: 24px;
            background: #777;
            margin: 0 8px;
        }
        
        /* Zoom Info */
        .zoom-controls {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        #zoom-percent {
            font-size: 14px;
            color: #fff;
            padding: 0 8px;
            width: 50px;
            text-align: center;
        }

        .pdf-container {
            flex: 1; /* Take remaining space */
            overflow: auto; /* This is our main scrollbar now */
            text-align: center; /* Center the canvas horizontally */
            padding: 32px 16px;
        }

        #pdf-canvas {
            max-width: 100%;
            /* The shadow on the PDF page */
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); 
            background: white;
            /* Add margin so shadow is visible and pages are spaced */
            margin-bottom: 24px; 
        }

        .loading {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            text-align: center;
            z-index: 1000;
        }

        .spinner {
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-top: 4px solid #fff;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 0 auto 15px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .loading-text {
            color: #fff;
            font-size: 16px;
            background: rgba(0, 0, 0, 0.7);
            padding: 10px 20px;
            border-radius: 6px;
        }
        
        @media (max-width: 768px) {
            .toolbar {
                height: auto;
                flex-wrap: wrap;
                justify-content: center;
                padding: 8px;
            }
            .toolbar-group.left,
            .toolbar-group.right {
                display: none; /* Hide filename and actions on small screens */
            }
            .toolbar-group.center {
                flex-wrap: wrap;
                justify-content: center;
            }
        }

        @media print {
            /* Hide everything except the canvas when printing */
            body > *:not(.pdf-container) {
                display: none;
            }
            body {
                background: #fff; /* Print on white */
            }
            .pdf-container {
                padding: 0;
                overflow: visible;
            }
            #pdf-canvas {
                box-shadow: none;
                margin: 0;
            }
        }
    </style>
</head>
<body>
    
    <div class="toolbar">
        <div class="toolbar-group left">
            <span class="doc-title" title="${pdfData.originalName}">${pdfData.originalName}</span>
        </div>

        <div class="toolbar-group center">
            <div class="page-controls">
                <button class="toolbar-btn" id="prev-page" title="Previous Page">◀</button>
                <div class="page-info">
                    <span id="page-num">1</span> / <span id="page-count">-</span>
                </div>
                <button class="toolbar-btn" id="next-page" title="Next Page">▶</button>
            </div>

            <div class="separator"></div>

            <div class="zoom-controls">
                <button class="toolbar-btn" id="zoom-out" title="Zoom Out">−</button>
                <span id="zoom-percent">150%</span>
                <button class="toolbar-btn" id="zoom-in" title="Zoom In">+</button>
            </div>
        </div>

        <div class="toolbar-group right">
            ${pdfData.allowDownload ? `
                <button class="toolbar-btn" id="download-btn" title="Download">
                    <svg fill="currentColor" width="20" height="20" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                </button>
            ` : ''}
            <button class="toolbar-btn" id="print-btn" title="Print">
                <svg fill="currentColor" width="20" height="20" viewBox="0 0 24 24"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zM16 19H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zM18 3H6v4h12V3z"/></svg>
            </button>
        </div>
    </div>
    
    <div class="pdf-container">
        <canvas id="pdf-canvas"></canvas>
    </div>
    
    <div class="loading" id="loading">
        <div class="spinner"></div>
        <div class="loading-text">Loading document...</div>
    </div>
    
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    
    <script>
        const trackingId = '${trackingId}';
        const startTime = Date.now();
        let currentPage = 1;
        
        // Track time spent and page views
        const pageViews = new Set();
        
        function trackPageView(pageNum) {
            if (!pageViews.has(pageNum)) {
                pageViews.add(pageNum);
                fetch('/api/track-page', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trackingId, page: pageNum })
                });
            }
        }
        
        // Track time on page close
        window.addEventListener('beforeunload', () => {
            const timeSpent = Math.floor((Date.now() - startTime) / 1000);
            const data = JSON.stringify({ 
                trackingId, 
                timeSpent,
                pagesViewed: Array.from(pageViews).length,
                totalPages: pdfDoc ? pdfDoc.numPages : 0
            });
            // Use sendBeacon for reliable background tracking
            navigator.sendBeacon('/api/track-session', data);
        });
        
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        let pdfDoc = null;
        let pageNum = 1;
        let pageRendering = false;
        let pageNumPending = null;
        let scale = 1.5; // Initial scale
        
        const canvas = document.getElementById('pdf-canvas');
        const ctx = canvas.getContext('2d');
        const loading = document.getElementById('loading');
        
  
        const zoomPercent = document.getElementById('zoom-percent');
        const printBtn = document.getElementById('print-btn')
        
        
        function updateZoomDisplay() {
        zoomPercent.textContent = Math.round(scale * 100) + '%';
        }

          function renderPage(num) {
      pageRendering = true;
      currentPage = num;
      trackPageView(num);
      updateZoomDisplay();

      pdfDoc.getPage(num).then(page => {
          const viewport = page.getViewport({ scale: scale });

          const dpi = window.devicePixelRatio || 1;

          canvas.style.width = viewport.width + "px";
          canvas.style.height = viewport.height + "px";

          canvas.width = viewport.width * dpi;
          canvas.height = viewport.height * dpi;

          const transform = [dpi, 0, 0, dpi, 0, 0];

          const renderContext = {
              canvasContext: ctx,
              viewport: viewport,
              transform: transform
          };

          page.render(renderContext).promise.then(() => {
              pageRendering = false;

              if (pageNumPending !== null) {
                  renderPage(pageNumPending);
                  pageNumPending = null;
              }
          });
      });

    document.getElementById('page-num').textContent = num;

    document.getElementById('prev-page').disabled = num <= 1;
    document.getElementById('next-page').disabled = num >= pdfDoc.numPages;
}

        
        function queueRenderPage(num) {
            if (pageRendering) {
                pageNumPending = num;
            } else {
                renderPage(num);
            }
        }
        
        function onPrevPage() {
            if (pageNum <= 1) return;
            pageNum--;
            queueRenderPage(pageNum);
        }
        
        function onNextPage() {
            if (pageNum >= pdfDoc.numPages) return;
            pageNum++;
            queueRenderPage(pageNum);
        }
        
        document.getElementById('prev-page').addEventListener('click', onPrevPage);
        document.getElementById('next-page').addEventListener('click', onNextPage);
        
        document.getElementById('zoom-in').addEventListener('click', () => {
            scale += 0.2;
            queueRenderPage(pageNum);
        });
        
        document.getElementById('zoom-out').addEventListener('click', () => {
            if (scale > 0.5) {
                scale -= 0.2;
                queueRenderPage(pageNum);
            }
        });

        printBtn.addEventListener('click', () => {
            window.print();
        });
        
        const downloadBtn = document.getElementById('download-btn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => {
                fetch('/api/log-download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trackingId })
                }).then(() => {
                    window.location.href = '/download/' + trackingId;
                });
            });
        }
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') onPrevPage();
            if (e.key === 'ArrowRight') onNextPage();
        });
        
        pdfjsLib.getDocument('/get-pdf/' + trackingId).promise.then(pdf => {
            pdfDoc = pdf;
            document.getElementById('page-count').textContent = pdf.numPages;
            loading.style.display = 'none';
            renderPage(pageNum); // This will render the page and set the initial zoom %
        }).catch(err => {
            loading.innerHTML = '<div class="loading-text" style="background: #ef4444;">Error loading document</div>';
            console.error('Error loading PDF:', err);
        });
    </script>
</body>
</html>
  `);
});

app.get('/get-pdf/:trackingId', (req, res) => {
  try {
    const { trackingId } = req.params;
    const trackingData = getTrackingData();

    if (!trackingData[trackingId]) {
      return res.status(404).send('PDF not found');
    }

    const filePath = path.join(__dirname, 'uploads', trackingData[trackingId].fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('PDF file not found');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).send('Error serving PDF');
  }
});

app.get('/download/:trackingId', (req, res) => {
  try {
    const { trackingId } = req.params;
    const trackingData = getTrackingData();

    if (!trackingData[trackingId]) {
      return res.status(404).send('PDF not found');
    }

    const filePath = path.join(__dirname, 'uploads', trackingData[trackingId].fileName);
    
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

app.post('/api/log-download', express.json(), (req, res) => {
  const { trackingId } = req.body;
  logAccess(trackingId, 'download', req);
  res.json({ success: true });
});

app.post('/api/track-page', express.json(), (req, res) => {
  const { trackingId, page } = req.body;
  logAccess(trackingId, 'page_view', req, { page });
  res.json({ success: true });
});

app.post('/api/track-session', express.json(), (req, res) => {
  const { trackingId, timeSpent, pagesViewed, totalPages } = req.body;
  
  const trackingData = getTrackingData();
  if (trackingData[trackingId] && trackingData[trackingId].accessLogs.length > 0) {
    const lastLog = trackingData[trackingId].accessLogs[trackingData[trackingId].accessLogs.length - 1];
    if (lastLog.action === 'view') {
      lastLog.timeSpent = timeSpent;
      lastLog.pagesViewed = pagesViewed;
      lastLog.totalPages = totalPages;
      lastLog.completion = totalPages > 0 ? Math.round((pagesViewed / totalPages) * 100) : 0;
      saveTrackingData(trackingData);
    }
  }
  
  res.json({ success: true });
});

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

app.get('/api/stats', (req, res) => {
  try {
    const trackingData = getTrackingData();
    res.json(trackingData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/delete/:trackingId', (req, res) => {
  try {
    const { trackingId } = req.params;
    const trackingData = getTrackingData();

    if (!trackingData[trackingId]) {
      return res.status(404).json({ error: 'PDF not found' });
    }

    const filePath = path.join(__dirname, 'uploads', trackingData[trackingId].fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    delete trackingData[trackingId];
    saveTrackingData(trackingData);

    res.json({ success: true, message: 'PDF deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`PDF Tracker running on http://localhost:${PORT}`);
  console.log(`Share viewer links to track PDFs!`);
});