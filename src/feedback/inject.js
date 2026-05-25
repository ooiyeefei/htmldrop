import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGET_PATH = join(__dirname, '../../templates/annotation-widget.html');

export function injectFeedbackWidget(html, { docId, workerUrl }) {
  const config = JSON.stringify({ docId, workerUrl }).replace(/</g, '\\u003c');
  const configTag = `<script type="application/json" id="htmldrop-config">${config}</script>`;

  let widgetHtml;
  try {
    widgetHtml = readFileSync(WIDGET_PATH, 'utf-8');
  } catch {
    widgetHtml = `<!-- htmldrop: annotation widget template not found -->`;
  }

  const injection = `${configTag}\n${widgetHtml}`;

  if (html.includes('</body>')) {
    return html.replace('</body>', `${injection}\n</body>`);
  }
  if (html.includes('</html>')) {
    return html.replace('</html>', `${injection}\n</html>`);
  }
  return html + `\n${injection}`;
}
