import { createHash } from 'node:crypto';
import { parse, parseFragment } from 'parse5';

export const LIMITS = Object.freeze({ html: 2 * 1024 * 1024, scene: 6 * 1024 * 1024, svg: 8 * 1024 * 1024, elements: 5000, files: 100, file: 3 * 1024 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHAPE_ID = /^[\w-]{1,128}$/;
const TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'line', 'arrow', 'freedraw', 'image', 'frame', 'magicframe']);
export function fail(message, statusCode = 400, extra = {}) { throw Object.assign(new Error(message), { statusCode, ...extra }); }
export const sourceHash = (source) => createHash('sha256').update(source).digest('hex');
export const isUUID = (id) => typeof id === 'string' && UUID.test(id);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const byteLength = (value) => Buffer.byteLength(value, 'utf8');

function jsonClone(value, maxBytes) {
  let budget = 200000;
  function visit(item, depth) {
    if (--budget < 0 || depth > 32) fail('Scene structure exceeds the supported limits');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) fail('Scene numbers must be finite and bounded'); return; }
    if (typeof item === 'string') { if (item.length > LIMITS.file * 2) fail('Scene string exceeds the supported limit'); return; }
    if (typeof item !== 'object') fail('Scene must contain JSON values only');
    for (const [key, entry] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsupported scene property');
      visit(entry, depth + 1);
    }
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (byteLength(text) > maxBytes) fail('Scene exceeds the supported byte limit');
  return JSON.parse(text);
}

function rasterData(value) {
  if (typeof value !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('Images must be bounded PNG, JPEG, GIF or WebP data URLs');
  const content = value.slice(value.indexOf(',') + 1);
  if (content.length % 4 !== 0 || Buffer.from(content, 'base64').length > LIMITS.file) fail('Image data exceeds the supported limit or is invalid');
}

export function validateScene(input) {
  if (!object(input) || input.type !== 'excalidraw' || input.version !== 2 || !Array.isArray(input.elements) || !object(input.appState) || !object(input.files)) fail('A native Excalidraw version 2 scene with elements, appState and files is required');
  const scene = jsonClone(input, LIMITS.scene);
  if (scene.elements.length > LIMITS.elements) fail('Too many diagram elements');
  const ids = new Set();
  for (const el of scene.elements) {
    if (!object(el) || !TYPES.has(el.type) || !SHAPE_ID.test(el.id || '') || ids.has(el.id)) fail('Elements require unique stable IDs and a supported native type');
    ids.add(el.id);
    for (const field of ['x', 'y', 'width', 'height']) if (typeof el[field] !== 'number' || !Number.isFinite(el[field]) || Math.abs(el[field]) > 1e7 || (['width', 'height'].includes(field) && el[field] < 0)) fail('Element geometry must be finite and bounded');
    if (el.link != null && el.link !== '') fail('Linked shapes and web embeds are not supported');
    if (el.type === 'text' && (typeof el.text !== 'string' || el.text.length > 100000)) fail('Text elements need bounded text');
    if (el.angle != null && (typeof el.angle !== 'number' || Math.abs(el.angle) > 1e7)) fail('Element angle must be finite and bounded');
    if (el.points != null && (!Array.isArray(el.points) || el.points.length > 20000 || el.points.some((point) => !Array.isArray(point) || point.length !== 2 || point.some((n) => typeof n !== 'number' || Math.abs(n) > 1e7)))) fail('Invalid line or freehand points');
  }
  const entries = Object.entries(scene.files);
  if (entries.length > LIMITS.files) fail('Too many image files');
  for (const [id, file] of entries) {
    if (!SHAPE_ID.test(id) || !object(file) || file.id !== id) fail('Invalid image file identity');
    rasterData(file.dataURL);
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimeType) || !file.dataURL.startsWith(`data:${file.mimeType};base64,`)) fail('Invalid image MIME type');
  }
  for (const el of scene.elements) if (el.type === 'image' && el.fileId != null && !Object.hasOwn(scene.files, el.fileId)) fail('Image shape references a missing file');
  for (const el of scene.elements) {
    const reference = (id) => { if (typeof id !== 'string' || !ids.has(id)) fail('Element references a missing shape'); };
    for (const field of ['containerId', 'frameId']) if (el[field] != null) reference(el[field]);
    for (const field of ['startBinding', 'endBinding']) if (el[field] != null) {
      if (!object(el[field])) fail('Invalid shape binding');
      reference(el[field].elementId);
    }
    if (el.boundElements != null) {
      if (!Array.isArray(el.boundElements) || el.boundElements.length > LIMITS.elements) fail('Invalid bound shape list');
      for (const bound of el.boundElements) { if (!object(bound)) fail('Invalid bound shape'); reference(bound.id); }
    }
  }
  function checkLinks(value) {
    if (!object(value) && !Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:url|href|src|link|iframe|embed|embeddable|libraryItems)$/i.test(key) && item != null && item !== '' && !(Array.isArray(item) && !item.length)) fail('External resources and embeds are not supported in scenes');
      checkLinks(item);
    }
  }
  checkLinks(scene.elements); checkLinks(scene.appState);
  return scene;
}

// XML is checked before the HTML namespace parser. This prevents error recovery
// from silently accepting malformed SVG, entities, duplicate attributes or DTDs.
function checkXml(svg) {
  const stack = [];
  let offset = 0, roots = 0, nodes = 0;
  function badEntities(value) {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) return true;
    return [...value.matchAll(/&#(x[\da-fA-F]+|\d+);/g)].some((match) => {
      const n = match[1][0] === 'x' ? Number.parseInt(match[1].slice(1), 16) : Number(match[1]);
      return !([9, 10, 13].includes(n) || n >= 0x20 && n <= 0xd7ff || n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff);
    });
  }
  while (offset < svg.length) {
    if (++nodes > 100000) fail('SVG exceeds the supported node limit');
    if (svg.startsWith('<!--', offset)) {
      const end = svg.indexOf('-->', offset + 4);
      if (end < 0 || svg.slice(offset + 4, end).includes('--')) fail('Invalid SVG XML comment');
      offset = end + 3; continue;
    }
    if (svg[offset] !== '<') {
      const end = svg.indexOf('<', offset), text = svg.slice(offset, end < 0 ? svg.length : end);
      if (badEntities(text) || text.includes(']]>') || (!stack.length && text.trim())) fail('Invalid SVG XML text');
      offset = end < 0 ? svg.length : end; continue;
    }
    if (svg.startsWith('<?xml ', offset) && offset === 0) {
      const declaration = svg.slice(offset).match(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i);
      if (!declaration) fail('Invalid SVG XML declaration');
      offset += declaration[0].length; continue;
    }
    const close = svg.slice(offset).match(/^<\/([A-Za-z_][\w:.-]*)\s*>/);
    if (close) { if (stack.pop() !== close[1]) fail('Unbalanced SVG XML'); offset += close[0].length; continue; }
    const open = svg.slice(offset).match(/^<([A-Za-z_][\w:.-]*)/);
    if (!open) fail('Invalid SVG XML markup');
    offset += open[0].length;
    const attrs = new Set();
    while (!/^\s*\/?>/.test(svg.slice(offset))) {
      const attr = svg.slice(offset).match(/^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/);
      if (!attr || attrs.has(attr[1]) || badEntities(attr[2] ?? attr[3]) || (attr[1].includes(':') && !/^(?:xml|xmlns|xlink):/.test(attr[1]))) fail('Invalid or duplicate SVG XML attribute');
      attrs.add(attr[1]); offset += attr[0].length;
    }
    const tail = svg.slice(offset).match(/^\s*(\/?)>/);
    offset += tail[0].length;
    if (!stack.length && ++roots !== 1) fail('SVG must have exactly one root');
    if (!tail[1]) stack.push(open[1]);
    if (stack.length > 100) fail('SVG nesting exceeds the supported limit');
  }
  if (stack.length || roots !== 1) fail('Incomplete SVG XML');
}

const SVG_TAGS = new Set(['svg', 'metadata', 'g', 'defs', 'style', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'image', 'use', 'symbol', 'title', 'desc', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feFuncA', 'feFuncR', 'feFuncG', 'feFuncB', 'feMerge', 'feMergeNode', 'feFlood', 'feComposite', 'marker']);
function safeCss(value) {
  // CSS escapes/comments can disguise URLs and at-rules. Excalidraw does not
  // need either; embedded data fonts and same-SVG fragments are supported.
  if (/[\\]|\/\*|@import|expression\s*\(|behavior\s*:|-moz-binding|javascript:/i.test(value)) fail('Unsafe SVG CSS');
  let rest = value.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi, (_, quote, url) => {
    if (!/^#[\w:.-]+$/.test(url) && !/^data:(?:font\/[\w.+-]+|application\/(?:font-woff|x-font-ttf|octet-stream));base64,[A-Za-z0-9+/=]+$/i.test(url)) fail('SVG CSS may only reference local fragments or embedded fonts');
    return '';
  });
  if (/url\s*\(|https?:|(?:^|[^\w])\/\//i.test(rest) || /@(?!font-face\b)/i.test(rest)) fail('Unsupported SVG CSS');
}

export function validateSvg(input) {
  let svg = input;
  if (typeof svg !== 'string' || !svg.trim()) fail('A fresh SVG preview is required; export it with Excalidraw before saving');
  if (svg.startsWith('data:image/svg+xml;base64,')) {
    const encoded = svg.slice(26);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) fail('Invalid SVG data URL');
    svg = Buffer.from(encoded, 'base64').toString('utf8');
  }
  if (byteLength(svg) > LIMITS.svg || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(svg) || /[\uD800-\uDFFF]/u.test(svg)) fail('SVG exceeds limits or contains invalid characters');
  checkXml(svg);
  const fragment = parseFragment(svg);
  const roots = fragment.childNodes.filter((n) => n.nodeName !== '#comment' && !(n.nodeName === '#text' && !n.value.trim()));
  if (roots.length !== 1 || roots[0].tagName !== 'svg') fail('Preview must be an SVG document');
  let count = 0;
  function walk(node) {
    if (++count > 100000) fail('SVG exceeds the supported node limit');
    if (node.nodeName === '#text' || node.nodeName === '#comment') return;
    if (node.namespaceURI !== 'http://www.w3.org/2000/svg' || !SVG_TAGS.has(node.tagName)) fail('Unsupported or active SVG content');
    for (const attr of node.attrs || []) {
      const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      if (/^on/i.test(name) || /^(?:src|srcset|base|xml:base)$/i.test(name)) fail('SVG event handlers and external resources are forbidden');
      if (/^(?:href|xlink:href)$/i.test(name)) {
        if (/^#[\w:.-]+$/.test(attr.value)) continue;
        if (node.tagName === 'image') { rasterData(attr.value); continue; }
        fail('SVG links must reference a local fragment');
      }
      if (name === 'xmlns' && attr.value !== 'http://www.w3.org/2000/svg') fail('Invalid SVG namespace');
      if (name === 'xmlns:xlink' && attr.value !== 'http://www.w3.org/1999/xlink') fail('Invalid SVG link namespace');
      if (!/^xmlns(?::|$)/.test(name)) safeCss(attr.value);
    }
    if (node.tagName === 'style') safeCss((node.childNodes || []).map((n) => n.value || '').join(''));
    for (const child of node.childNodes || []) walk(child);
  }
  walk(roots[0]);
  return svg;
}

const attrs = (node) => Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));
const significant = (nodes) => nodes.filter((node) => !(node.nodeName === '#text' && !node.value.trim()));
export function parseDocument(source) {
  if (typeof source !== 'string') fail('HTML must be a string');
  if (byteLength(source) > LIMITS.html) fail('HTML exceeds the 2 MB publication limit; reduce embedded images or diagram size', 413);
  const errors = [], tree = parse(source, { sourceCodeLocationInfo: true, onParseError: (e) => errors.push(e) });
  const all = [], parents = new Map();
  function visit(node, parent, inTemplate = false) {
    all.push(node); parents.set(node, { parent, inTemplate });
    for (const child of node.childNodes || []) visit(child, node, inTemplate);
    if (node.content) visit(node.content, node, true);
  }
  visit(tree, null);
  const metadata = all.filter((node) => node.tagName === 'meta' && attrs(node).name?.toLowerCase() === 'htmldrop-document-id');
  if (metadata.length > 1) fail('Duplicate document identity metadata');
  let documentId = null;
  if (metadata.length) {
    const node = metadata[0]; documentId = attrs(node).content;
    if (!isUUID(documentId) || parents.get(node).inTemplate) fail('Invalid document identity metadata');
  }
  const markers = all.filter((node) => node.nodeName === '#comment' && /^\s*htmldrop:diagram:/.test(node.data));
  const figures = all.filter((node) => Object.hasOwn(attrs(node), 'data-htmldrop-diagram'));
  const scenes = all.filter((node) => Object.hasOwn(attrs(node), 'data-htmldrop-scene'));
  const used = new Set(), diagrams = [], ids = new Set();
  for (const start of markers) {
    const match = start.data.trim().match(/^htmldrop:diagram:([^:]+):(start|end)$/);
    if (!match || !isUUID(match[1])) fail('Malformed managed diagram marker');
    if (match[2] === 'end') continue;
    const id = match[1];
    if (ids.has(id) || !documentId || parents.get(start).inTemplate) fail('Duplicate diagram identity or missing document identity');
    ids.add(id);
    const parent = parents.get(start).parent, siblings = significant(parent.childNodes || []), index = siblings.indexOf(start);
    const figure = siblings[index + 1], end = siblings[index + 2];
    if (figure?.tagName !== 'figure' || attrs(figure)['data-htmldrop-diagram'] !== id || end?.nodeName !== '#comment' || end.data.trim() !== `htmldrop:diagram:${id}:end`) fail('Managed diagram markers must surround exactly one matching figure');
    const children = significant(figure.childNodes || []), img = children[0], script = children[1];
    if (children.length !== 2 || img?.tagName !== 'img' || script?.tagName !== 'script' || attrs(script).type !== 'application/json' || attrs(script)['data-htmldrop-scene'] !== id) fail('Managed diagram requires one preview image and one JSON scene');
    if (!attrs(img).src?.startsWith('data:image/svg+xml;base64,')) fail('Managed preview requires an SVG data URL');
    let entry;
    try { entry = JSON.parse((script.childNodes || []).map((node) => node.value || '').join('')); } catch { fail('Invalid embedded diagram JSON'); }
    if (!object(entry) || entry.version !== 1 || entry.documentId !== documentId || entry.diagramId !== id || !isUUID(entry.revisionId) || (entry.parentRevisionId !== null && !isUUID(entry.parentRevisionId)) || typeof entry.title !== 'string' || entry.title.length > 500) fail('Invalid embedded diagram identity');
    const scene = validateScene(entry.scene), svg = validateSvg(attrs(img).src);
    const location = { start: start.sourceCodeLocation.startOffset, end: end.sourceCodeLocation.endOffset };
    if (errors.some((error) => error.code === 'duplicate-attribute' && error.startOffset >= location.start && error.startOffset < location.end)) fail('Duplicate managed diagram attribute');
    diagrams.push({ ...entry, scene, svg, location }); used.add(start); used.add(end); used.add(figure); used.add(script);
  }
  if (markers.some((node) => !used.has(node)) || figures.some((node) => !used.has(node)) || scenes.some((node) => !used.has(node))) fail('Orphaned or ambiguous managed diagram block');
  if (metadata.some((node) => errors.some((error) => error.code === 'duplicate-attribute' && error.startOffset >= node.sourceCodeLocation.startOffset && error.startOffset < node.sourceCodeLocation.endOffset))) fail('Duplicate document metadata attribute');
  const head = all.find((node) => node.tagName === 'head'), body = all.find((node) => node.tagName === 'body'), doctype = all.find((node) => node.nodeName === '#documentType');
  return { source, sourceHash: sourceHash(source), documentId, diagrams, metaOffset: head?.sourceCodeLocation?.startTag?.endOffset ?? doctype?.sourceCodeLocation?.endOffset ?? 0, appendOffset: body?.sourceCodeLocation?.endTag?.startOffset ?? source.length };
}

const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function serializeDiagram(entry, svg) {
  const { documentId, diagramId, revisionId, parentRevisionId, title, scene } = entry;
  const json = JSON.stringify({ version: 1, documentId, diagramId, revisionId, parentRevisionId, title, scene }).replace(/</g, '\\u003c');
  return `<!-- htmldrop:diagram:${diagramId}:start -->\n<figure data-htmldrop-diagram="${diagramId}" style="margin-block:1em;margin-inline:0">\n  <img alt="${escapeAttr(title)}" style="max-width:100%;height:auto;display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">\n  <script type="application/json" data-htmldrop-scene="${diagramId}">${json}</script>\n</figure>\n<!-- htmldrop:diagram:${diagramId}:end -->`;
}

export function replaceDiagram(document, entry, svg) {
  const existing = document.diagrams.find((item) => item.diagramId === entry.diagramId);
  const edits = existing ? [{ start: existing.location.start, end: existing.location.end, value: serializeDiagram(entry, svg) }] : [{ start: document.appendOffset, end: document.appendOffset, value: `\n${serializeDiagram(entry, svg)}\n` }];
  if (!document.documentId) edits.push({ start: document.metaOffset, end: document.metaOffset, value: `\n<meta name="htmldrop-document-id" content="${entry.documentId}">\n` });
  let source = document.source;
  // Stable sorting preserves metadata placement when an empty file has both
  // insertions at zero (apply the diagram first, then prepend the metadata).
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  parseDocument(source);
  return source;
}
