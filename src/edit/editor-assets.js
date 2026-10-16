import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
const root = fileURLToPath(new URL("./editor-dist/", import.meta.url));
const types = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};
export async function serveEditorAsset(req, res, { key, assetPath = "" }) {
  if (!/^[a-f0-9]{16}$/.test(key)) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
  if (!assetPath || assetPath === "index.html") {
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    );
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagram editor · HTML Drop</title><link rel="stylesheet" href="/s/${key}/__editor/editor.css"><div id="root"></div><script type="module" src="/s/${key}/__editor/boot.js"></script></html>`,
    );
    return;
  }
  if (assetPath === "boot.js") {
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
    });
    res.end(
      `window.EXCALIDRAW_ASSET_PATH = location.origin + '/s/${key}/__editor/'; import('./editor.js');`,
    );
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(assetPath);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (
    !decoded ||
    decoded.includes("\\") ||
    decoded.split("/").some((p) => !p || p.startsWith(".")) ||
    !types[extname(decoded)]
  ) {
    res.writeHead(404).end();
    return;
  }
  const file = resolve(root, decoded);
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    let current = root;
    for (const part of decoded.split("/")) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw Error("symlink");
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(decoded)] });
    res.end(data);
  } catch {
    res
      .writeHead(404)
      .end("Editor asset unavailable; rebuild the package editor.");
  }
}

// Lazy editor launcher: no canvas dependencies enter the artifact or its exports.
export function injectDiagramLauncher(html, { key }) {
  if (!/^[a-f0-9]{16}$/.test(key)) return html;
  const script = `<script>(function(){
var key=${JSON.stringify(key)},frame=null,host=null,dirty=false,changed=false;
var button=document.createElement('button');button.textContent='Diagrams';button.id='htmldrop-diagrams';button.style.cssText='position:fixed;bottom:18px;left:18px;z-index:999995;padding:10px 16px;border:1px solid #c8cbd2;border-radius:6px;background:#fff;color:#25262b;font:600 13px Arial;cursor:pointer';document.body.appendChild(button);
function open(id){if(frame){frame.focus();return;}host=document.createElement('div');host.id='htmldrop-diagram-editor';host.style.cssText='position:fixed;inset:0;z-index:1000001;background:white';frame=document.createElement('iframe');frame.title='Diagram editor';frame.src='/s/'+key+'/__editor/'+(id?'?diagram='+encodeURIComponent(id):'');frame.style.cssText='width:100%;height:100%;border:0;display:block';host.appendChild(frame);document.body.appendChild(host);window.__htmldropDiagramEditorOpen=true;window.dispatchEvent(new CustomEvent('htmldrop:diagram-editor-open'));}
button.addEventListener('click',function(){open();});document.addEventListener('dblclick',function(e){var figure=e.target.closest&&e.target.closest('[data-htmldrop-diagram]');if(figure)open(figure.getAttribute('data-htmldrop-diagram'));});
window.addEventListener('message',function(e){if(e.origin!==location.origin||!frame||e.source!==frame.contentWindow)return;var d=e.data||{};if(d.type==='htmldrop:diagram-dirty'){dirty=!!d.dirty;window.__htmldropDiagramDirty=dirty;}if(d.type==='htmldrop:diagram-close'){host.remove();host=null;frame=null;window.__htmldropDiagramEditorOpen=false;window.__htmldropDiagramDirty=false;window.dispatchEvent(new CustomEvent('htmldrop:diagram-editor-close'));if(changed)location.reload();}if(d.type==='htmldrop:diagram-saved')changed=true;if(d.type==='htmldrop:diagram-comment'){window.dispatchEvent(new CustomEvent('htmldrop:diagram-comment',{detail:{id:d.id}}));window.dispatchEvent(new CustomEvent('htmldrop:feedback-refresh'));}});
window.addEventListener('htmldrop:diagram-source-changed',function(){changed=true;if(frame)frame.contentWindow.postMessage({type:'htmldrop:diagram-source-changed'},location.origin);});
})();</script>`;
  return /<\/body\s*>/i.test(html)
    ? html.replace(/<\/body\s*>/i, script + "</body>")
    : html + script;
}
