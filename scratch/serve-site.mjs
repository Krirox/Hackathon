// Tiny static file server for previewing site/ locally: node scratch/serve-site.mjs
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('site');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!/\.[a-z0-9]+$/i.test(pathname) && !pathname.endsWith('/')) {
    res.writeHead(301, { location: pathname + '/' });
    res.end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(root, pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  createReadStream(file)
    .on('open', () => {
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    })
    .on('error', () => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
    })
    .pipe(res);
}).listen(4173, () => console.log('serving site/ on http://localhost:4173'));
