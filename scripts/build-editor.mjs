import { build } from "esbuild";
import { mkdir, rm, cp, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}src/edit/editor-dist`;
// Excalidraw 0.18.1 appends a CDN fallback to every FontFace even when an
// explicit self-hosted asset path is configured. Browsers can attempt those
// URLs despite a working local font and CSP. Strip only that fallback append
// while bundling; never modify node_modules, and fail closed on upstream drift.
const upstream = JSON.parse(
  await readFile(
    `${root}node_modules/@excalidraw/excalidraw/package.json`,
    "utf8",
  ),
);
if (upstream.version !== "0.18.1")
  throw Error(
    "Review the offline font transform before changing Excalidraw versions.",
  );
let removedFontFallbacks = 0;
const offlineExcalidrawFonts = {
  name: "offline-excalidraw-fonts",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/]chunk-.*\.js$/,
      },
      async ({ path }) => {
        const source = await readFile(path, "utf8");
        if (!source.includes("ASSETS_FALLBACK_URL")) return;
        const append =
          /return ([A-Za-z_$][\w$]*)\.push\(new URL\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.ASSETS_FALLBACK_URL\)\),\1/g;
        const matches = [...source.matchAll(append)];
        if (matches.length !== 1)
          throw Error(
            "Excalidraw's font fallback changed; review the offline font transform.",
          );
        removedFontFallbacks += matches.length;
        return { contents: source.replace(append, "return $1"), loader: "js" };
      },
    );
  },
};
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [`${root}src/edit/browser/editor.jsx`],
  outdir: out,
  entryNames: "editor",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  conditions: ["production"],
  define: { "process.env.NODE_ENV": '"production"' },
  loader: {
    ".woff2": "file",
    ".woff": "file",
    ".ttf": "file",
    ".wasm": "file",
  },
  legalComments: "linked",
  metafile: true,
  plugins: [offlineExcalidrawFonts],
}).then(async (result) => {
  if (removedFontFallbacks !== 1)
    throw Error(
      "The offline font transform did not run exactly once; do not ship this editor.",
    );
  await writeFile(
    `${out}/manifest.json`,
    JSON.stringify(
      Object.keys(result.metafile.outputs)
        .map((path) => relative(out, resolve(path)))
        .sort(),
      null,
      2,
    ),
  );
});
await cp(
  `${root}node_modules/@excalidraw/excalidraw/dist/prod/fonts`,
  `${out}/fonts`,
  { recursive: true },
);
await cp(`${root}src/edit/browser/notices`, `${out}/notices`, {
  recursive: true,
});
for (const name of [
  "react",
  "react-dom",
  "@excalidraw/mermaid-to-excalidraw",
]) {
  await cp(
    `${root}node_modules/${name}/LICENSE`,
    `${out}/notices/${name.replaceAll("/", "-")}.txt`,
  );
}
console.error("Built packaged Excalidraw editor and local fonts.");
