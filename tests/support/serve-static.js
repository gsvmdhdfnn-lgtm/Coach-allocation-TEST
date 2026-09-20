/**
 * Shared static-file responder used by every mock server in this suite.
 * Serves the real, current app files straight from the repo root (so a
 * test always exercises today's index.html/core.js/etc., never a stale
 * copy) with two overrides: /config.js and /data/Sessions.csv resolve to
 * the test fixtures instead of the real repo files, so the suite never
 * points at production Supabase/Airtable/Google Sheets.
 */
const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.png': 'image/png' };
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const OVERRIDES = {
  '/config.js': path.join(FIXTURES_DIR, 'config.test.js'),
  '/data/Sessions.csv': path.join(FIXTURES_DIR, 'data', 'Sessions.csv'),
};

function serveStatic(req, res, url, repoRoot) {
  const decoded = decodeURIComponent(url === '/' ? '/index.html' : url);
  const filePath = OVERRIDES[decoded] || path.join(repoRoot, decoded);
  fs.readFile(filePath, (err, body) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'text/plain' });
    res.end(body);
  });
}

module.exports = { serveStatic, CONTENT_TYPES };
