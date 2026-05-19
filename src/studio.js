import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import open from 'open';
import { getAuthorKey } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = join(__dirname, '../templates/dashboard.html');

export async function studio(options = {}) {
  const authorKey = getAuthorKey();
  const port = options.port || 3456;
  const workerUrl = options.workerUrl || 'https://htmldrop-feedback.htmldrop.workers.dev';

  const dashboardHtml = readFileSync(DASHBOARD_PATH, 'utf-8');

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardHtml);
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}#key=${authorKey}&worker=${encodeURIComponent(workerUrl)}`;
    console.log(`Converge Studio running at: ${url}`);
    console.log('Press Ctrl+C to stop.\n');
    if (!options.noBrowser) {
      open(url);
    }
  });
}
