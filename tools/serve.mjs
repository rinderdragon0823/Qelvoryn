/**
 * Minimal static file server for local development: `npm run serve`.
 * No dependencies - Node core modules only.
 *
 * Usage:
 *   node tools/serve.mjs [port]
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    let filePath = decodeURIComponent(url.pathname);
    if (filePath.endsWith('/')) filePath += 'index.html';
    const target = path.join(root, filePath);
    if (!target.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || stat.isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const body = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      // Enables SharedArrayBuffer-free COOP isolation checks if ever needed.
      'cross-origin-opener-policy': 'same-origin',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`500 ${err.message}`);
  }
});

server.listen(port, () => {
  console.log(`Qelvoryn dev server: http://localhost:${port}/`);
  console.log(`Serving: ${root}`);
});
