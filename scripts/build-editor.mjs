import { build } from "esbuild";
import { mkdir, rm, cp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}src/edit/editor-dist`;
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
}).then(async (result) => {
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
