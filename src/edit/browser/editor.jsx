import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  DefaultSidebar,
  MainMenu,
  exportToSvg,
  serializeAsJSON,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import "./editor.css";
const key = location.pathname.match(/^\/s\/([a-f0-9]{16})\/__editor\//)?.[1];
const base = `/api/edit/${key}/diagrams`;
window.EXCALIDRAW_ASSET_PATH = `${location.origin}/s/${key}/__editor/`;
const blank = () => ({
  type: "excalidraw",
  version: 2,
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});
function notify(type, detail = {}) {
  parent.postMessage(
    { type: `htmldrop:diagram-${type}`, ...detail },
    location.origin,
  );
}
async function request(path = "", body) {
  const res = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await res.json();
  if (!res.ok)
    throw new Error(
      res.status === 409
        ? "The document changed. Your draft is preserved. Export your draft, then reopen the current diagram before saving."
        : value.error || value.message || "The request failed. Try again.",
    );
  return value;
}
function signature(scene) {
  return JSON.stringify({
    elements: scene.elements,
    files: scene.files,
    background: scene.appState?.viewBackgroundColor,
  });
}
function validateImport(scene) {
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const types = new Set([
    "rectangle",
    "diamond",
    "ellipse",
    "text",
    "line",
    "arrow",
    "freedraw",
    "image",
    "frame",
    "magicframe",
  ]);
  if (
    !object(scene) ||
    scene.type !== "excalidraw" ||
    scene.version !== 2 ||
    !Array.isArray(scene.elements) ||
    scene.elements.length > 5000 ||
    !object(scene.appState || {}) ||
    !object(scene.files || {}) ||
    Object.keys(scene.files || {}).length > 100
  )
    throw Error(
      "Import a native version 2 diagram with at most 5,000 shapes and 100 images.",
    );
  const ids = new Set();
  for (const element of scene.elements) {
    if (
      !object(element) ||
      !types.has(element.type) ||
      typeof element.id !== "string" ||
      !/^[\w-]{1,128}$/.test(element.id) ||
      ids.has(element.id) ||
      ["x", "y", "width", "height"].some(
        (key) => !Number.isFinite(element[key]) || Math.abs(element[key]) > 1e9,
      )
    )
      throw Error(
        "The diagram contains an unsupported shape, duplicate ID or invalid geometry.",
      );
    ids.add(element.id);
  }
  let budget = 200000;
  function visit(value, depth = 0) {
    if (--budget < 0 || depth > 32)
      throw Error(
        "The imported diagram is too complex. Split it into smaller diagrams.",
      );
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    )
      throw Error("The diagram contains an invalid number.");
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw Error("The diagram contains an unsupported property.");
        visit(child, depth + 1);
      }
  }
  visit(scene);
  if (new TextEncoder().encode(JSON.stringify(scene)).length > 6 * 1024 * 1024)
    throw Error("Import a diagram smaller than 6 MB.");
  safeFiles(scene);
}
function safeFiles(scene) {
  for (const file of Object.values(scene.files || {}))
    if (
      !/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(
        file.dataURL || "",
      )
    )
      throw Error(
        "Use PNG, JPEG, WebP or GIF images stored inside the diagram.",
      );
  if (
    scene.elements?.some(
      (el) => el.type === "embeddable" || el.type === "iframe" || el.link,
    )
  )
    throw Error("Remove web embeds and shape links before saving.");
}
function reviewerToken() {
  try {
    let token = localStorage.getItem("htmldrop_reviewer_token");
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem("htmldrop_reviewer_token", token);
    }
    return token;
  } catch {
    return crypto.randomUUID();
  }
}
function download(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function svgFor(scene) {
  safeFiles(scene);
  const svg = await exportToSvg({
    elements: scene.elements.filter((el) => !el.isDeleted),
    appState: {
      ...scene.appState,
      exportBackground: true,
      exportEmbedScene: false,
    },
    files: scene.files,
    renderEmbeddables: false,
    exportPadding: 10,
  });
  return svg.outerHTML;
}
function threads(items) {
  return items
    .filter((c) => !c.parentId)
    .map((c) => ({
      ...c,
      text: c.content?.text || c.text,
      authorName: c.author?.displayName || c.authorName,
      replies: items
        .filter((r) => r.parentId === c.id)
        .map((r) => ({
          ...r,
          text: r.content?.text || r.text,
          authorName: r.author?.displayName || r.authorName,
        })),
    }));
}
function App() {
  const [listing, setListing] = useState(null),
    [doc, setDoc] = useState(null),
    [title, setTitle] = useState("Untitled diagram"),
    [status, setStatus] = useState("Opening diagrams…"),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState([]),
    [comments, setComments] = useState([]),
    [text, setText] = useState(""),
    [author, setAuthor] = useState(""),
    [mount, setMount] = useState(0),
    [initialScene, setInitialScene] = useState(blank),
    [proposalPreviews, setProposalPreviews] = useState({}),
    [review, setReview] = useState(true),
    [mermaid, setMermaid] = useState(false),
    [syntax, setSyntax] = useState("flowchart LR\n  A[Start] --> B[Finish]");
  const scene = useRef(blank()),
    baseline = useRef(""),
    api = useRef(null),
    file = useRef(null),
    mermaidDialog = useRef(null),
    titleBase = useRef("Untitled diagram"),
    dirtyRef = useRef(false),
    pendingBaseline = useRef(false),
    operations = useRef(0),
    generation = useRef(0);
  useEffect(() => {
    if (mermaid && mermaidDialog.current && !mermaidDialog.current.open)
      mermaidDialog.current.showModal();
  }, [mermaid]);
  const permissions = doc?.permissions || listing?.permissions || {};
  function message(value, bad = false) {
    setStatus(value);
    setError(bad);
  }
  function mark(value) {
    dirtyRef.current = value;
    setDirty(value);
    notify("dirty", { dirty: value });
  }
  async function run(fn) {
    operations.current += 1;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      message(e.message, true);
    } finally {
      operations.current -= 1;
      setBusy(operations.current > 0);
    }
  }
  async function refreshList() {
    const value = await request();
    setListing(value);
    return value;
  }
  async function load(id, force = false) {
    if (
      !force &&
      dirtyRef.current &&
      !confirm("Discard your unsaved diagram changes?")
    )
      return;
    await run(async () => {
      const value = await request(`/${id}`);
      setDoc(value);
      scene.current = value.scene;
      api.current = null;
      setInitialScene(value.scene);
      baseline.current = signature(value.scene);
      pendingBaseline.current = true;
      titleBase.current = value.title;
      setTitle(value.title);
      mark(false);
      setSelected([]);
      generation.current += 1;
      setMount(generation.current);
      const c = await request(`/${id}/comments`);
      setComments(threads(c.items || []));
      message("Diagram ready. Select a shape to comment.");
    });
  }
  useEffect(() => {
    if (!doc?.diagramId) return;
    const id = doc.diagramId;
    const events = new EventSource(`/__edit/events/${key}`);
    const refresh = () =>
      request(`/${id}/comments`)
        .then((value) => setComments(threads(value.items || [])))
        .catch(() => {});
    events.addEventListener("feedback", refresh);
    return () => events.close();
  }, [doc?.diagramId]);
  useEffect(() => {
    run(async () => {
      const value = await refreshList();
      const wanted = new URLSearchParams(location.search).get("diagram");
      if (wanted && value.diagrams.some((d) => d.diagramId === wanted))
        await load(wanted, true);
      else
        message(
          value.diagrams.length
            ? "Choose a diagram or create a canvas."
            : "Create a canvas or import a diagram to begin.",
        );
    });
    const before = (e) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const changed = (e) => {
      if (
        e.origin === location.origin &&
        e.source === parent &&
        e.data?.type === "htmldrop:diagram-source-changed"
      )
        message(
          "The source changed. Your draft is preserved; export it before reopening to avoid losing changes.",
          true,
        );
    };
    addEventListener("beforeunload", before);
    addEventListener("message", changed);
    return () => {
      removeEventListener("beforeunload", before);
      removeEventListener("message", changed);
    };
  }, []);
  function newCanvas(candidate = blank()) {
    if (dirtyRef.current && !confirm("Discard your unsaved diagram changes?"))
      return false;
    scene.current = candidate;
    api.current = null;
    setInitialScene(candidate);
    baseline.current = signature(blank());
    pendingBaseline.current = false;
    setDoc({ scene: candidate, permissions: listing?.permissions || {} });
    titleBase.current = "Untitled diagram";
    setTitle("Untitled diagram");
    setComments([]);
    setSelected([]);
    mark(true);
    generation.current += 1;
    setMount(generation.current);
    message("New canvas. Save it to add it to this document.");
    return true;
  }
  function currentScene() {
    return {
      type: "excalidraw",
      version: 2,
      source: "htmldrop",
      elements:
        api.current?.getSceneElementsIncludingDeleted() ||
        scene.current.elements,
      appState: api.current?.getAppState() || scene.current.appState,
      files: api.current?.getFiles() || scene.current.files,
    };
  }
  async function save(propose = false) {
    await run(async () => {
      const candidate = currentScene();
      const svg = await svgFor(candidate);
      const snapshot = doc?.diagramId ? doc : listing;
      const payload = {
        baseRevisionId: doc?.revisionId,
        baseSourceHash: snapshot.sourceHash,
        title,
        scene: JSON.parse(
          serializeAsJSON(
            candidate.elements,
            candidate.appState,
            candidate.files,
            "local",
          ),
        ),
        svg,
        summary: propose
          ? "Proposed from diagram editor"
          : "Edited in diagram editor",
      };
      const value = await request(
        doc?.diagramId
          ? `/${doc.diagramId}/${propose ? "proposals" : "save"}`
          : "",
        payload,
      );
      if (propose) {
        message("Proposal saved for owner review. Your draft remains open.");
        const next = await request(`/${doc.diagramId}`);
        setDoc(next);
      } else {
        mark(false);
        setDoc(value);
        scene.current = value.scene;
        baseline.current = signature(candidate);
        titleBase.current = title;
        message("Diagram saved.");
        notify("saved");
      }
      await refreshList();
    });
  }
  async function comment(e) {
    e.preventDefault();
    if (dirty) {
      message(
        "Save or propose your changes, then reopen the accepted diagram before commenting.",
        true,
      );
      return;
    }
    await run(async () => {
      const created = await request(`/${doc.diagramId}/comments`, {
        editToken: reviewerToken(),
        baseRevisionId: doc.revisionId,
        baseSourceHash: doc.sourceHash,
        shapeId: selected[0],
        text,
        authorName: author,
      });
      setText("");
      const c = await request(`/${doc.diagramId}/comments`);
      setComments(threads(c.items || []));
      message("Shape comment saved.");
      notify("comment", { id: created.id });
    });
  }
  async function accept(p) {
    if (dirtyRef.current) {
      message(
        "Export or discard your draft before accepting a proposal.",
        true,
      );
      return;
    }
    await run(async () => {
      const svg = await svgFor(p.scene);
      const value = await request(
        `/${doc.diagramId}/proposals/${p.proposalId}/accept`,
        {
          baseRevisionId: doc.revisionId,
          baseSourceHash: doc.sourceHash,
          svg,
          summary: p.summary || "Accepted proposal",
        },
      );
      mark(false);
      await load(value.diagramId, true);
      await refreshList();
      notify("saved");
    });
  }
  async function reject(p) {
    await run(async () => {
      await request(`/${doc.diagramId}/proposals/${p.proposalId}/reject`, {
        baseRevisionId: doc.revisionId,
        baseSourceHash: doc.sourceHash,
      });
      setDoc(await request(`/${doc.diagramId}`));
      message("Proposal rejected.");
    });
  }
  async function importJson(e) {
    const selectedFile = e.target.files?.[0];
    e.target.value = "";
    if (!selectedFile) return;
    await run(async () => {
      if (selectedFile.size > 12 * 1024 * 1024)
        throw Error("Choose a diagram file smaller than 12 MB.");
      const parsed = JSON.parse(await selectedFile.text());
      const candidate = parsed.scene || parsed;
      if (candidate.type !== "excalidraw" || !Array.isArray(candidate.elements))
        throw Error("Choose a native .excalidraw JSON file.");
      validateImport(candidate);
      newCanvas({
        ...candidate,
        files: candidate.files || {},
        appState: candidate.appState || {},
      });
    });
  }
  async function importMermaid() {
    await run(async () => {
      if (syntax.length > 50000 || syntax.split("\n").length > 1000)
        throw Error(
          "Keep Mermaid imports under 50,000 characters and 1,000 lines. Split a larger diagram into smaller diagrams.",
        );
      const { parseMermaidToExcalidraw } = await import(
        "@excalidraw/mermaid-to-excalidraw"
      );
      const result = await parseMermaidToExcalidraw(syntax);
      if (result.error)
        throw Error(result.error.message || "Check the Mermaid syntax.");
      const candidate = {
        ...blank(),
        elements: convertToExcalidrawElements(result.elements),
        files: result.files || {},
      };
      validateImport(candidate);
      const created = newCanvas(candidate);
      if (!created) {
        message("Import cancelled. Your current diagram is unchanged.");
        return;
      }
      setMermaid(false);
      message("Mermaid imported as a new editable diagram.");
    });
  }
  async function exportRevision(revisionId, format) {
    await run(async () => {
      const result = await request(
        `/${doc.diagramId}/export?format=${format}&revisionId=${encodeURIComponent(revisionId)}`,
      );
      download(
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content, null, 2),
        result.mimeType,
        `diagram-${revisionId}.${format === "svg" ? "svg" : "excalidraw"}`,
      );
    });
  }
  return (
    <main className="shell" aria-busy={busy}>
      <header className="toolbar" inert={busy ? "" : undefined}>
        <h1>Diagrams</h1>
        <select
          aria-label="Choose diagram"
          value={doc?.diagramId || ""}
          onChange={(e) => e.target.value && load(e.target.value)}
        >
          <option value="">Choose diagram</option>
          {listing?.diagrams.map((d) => (
            <option key={d.diagramId} value={d.diagramId}>
              {d.title}
            </option>
          ))}
        </select>
        {listing?.permissions?.create && (
          <>
            <button onClick={() => newCanvas()} disabled={busy}>
              New canvas
            </button>
            <button onClick={() => file.current.click()} disabled={busy}>
              Import JSON
            </button>
            <button onClick={() => setMermaid(true)} disabled={busy}>
              Import Mermaid
            </button>
          </>
        )}
        <input
          ref={file}
          type="file"
          className="file"
          accept=".json,.excalidraw"
          onChange={importJson}
        />
        {doc && (
          <>
            <input
              aria-label="Diagram title"
              maxLength={500}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                mark(true);
              }}
            />
            {(doc.diagramId ? permissions.save : permissions.create) && (
              <button
                className="primary"
                disabled={busy || !dirty}
                onClick={() => save()}
              >
                Save diagram
              </button>
            )}
            {doc.diagramId && permissions.propose && (
              <button disabled={busy || !dirty} onClick={() => save(true)}>
                Propose changes
              </button>
            )}
            {doc.diagramId && (
              <button disabled={busy} onClick={() => load(doc.diagramId)}>
                Reload current
              </button>
            )}
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const s = currentScene();
                  download(
                    serializeAsJSON(s.elements, s.appState, s.files, "local"),
                    "application/json",
                    `${title}.excalidraw`,
                  );
                })
              }
            >
              Export JSON
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run(async () =>
                  download(
                    await svgFor(currentScene()),
                    "image/svg+xml",
                    `${title}.svg`,
                  ),
                )
              }
            >
              Export SVG
            </button>
          </>
        )}
        <button aria-expanded={review} onClick={() => setReview((v) => !v)}>
          Review
        </button>
        <button
          onClick={() => {
            if (
              !dirtyRef.current ||
              confirm("Close and discard your unsaved diagram changes?")
            ) {
              mark(false);
              notify("close");
            }
          }}
        >
          Close editor
        </button>
      </header>
      <div className={`status ${error ? "error" : ""}`} role="status">
        {busy ? "Working… " : ""}
        {status}
        {dirty && <span className="changed"> · Unsaved changes</span>}
      </div>
      <div className="workspace" inert={busy ? "" : undefined}>
        <section className="canvas" aria-label="Diagram canvas">
          {doc ? (
            <Excalidraw
              key={mount}
              viewModeEnabled={busy}
              excalidrawAPI={(value) => {
                if (mount === generation.current) api.current = value;
              }}
              initialData={initialScene}
              onChange={(elements, appState, files) => {
                if (mount !== generation.current) return;
                scene.current = {
                  type: "excalidraw",
                  version: 2,
                  elements,
                  appState,
                  files,
                };
                const ids = Object.keys(appState.selectedElementIds).filter(
                  (id) => appState.selectedElementIds[id],
                );
                setSelected((previous) =>
                  previous.length === ids.length &&
                  previous.every((id, index) => id === ids[index])
                    ? previous
                    : ids,
                );
                if (pendingBaseline.current) {
                  baseline.current = signature(scene.current);
                  pendingBaseline.current = false;
                }
                const changed =
                  signature(scene.current) !== baseline.current ||
                  title !== titleBase.current;
                if (changed !== dirtyRef.current) mark(changed);
              }}
              aiEnabled={false}
              validateEmbeddable={false}
              onLinkOpen={(_, e) => e.preventDefault()}
              UIOptions={{
                canvasActions: {
                  loadScene: false,
                  export: false,
                  saveAsImage: false,
                },
              }}
            >
              <DefaultSidebar>
                <p className="muted">
                  Libraries are unavailable in this document editor. Import a
                  native diagram instead.
                </p>
              </DefaultSidebar>
              <MainMenu>
                <MainMenu.DefaultItems.ClearCanvas />
                <MainMenu.DefaultItems.ChangeCanvasBackground />
              </MainMenu>
            </Excalidraw>
          ) : (
            <div className="empty">
              <div>
                <h2>Draw together with your agent</h2>
                <p>
                  Open a diagram to edit its shapes, attach comments and review
                  proposed changes.
                </p>
              </div>
            </div>
          )}
        </section>
        {review && (
          <aside className="review" aria-label="Diagram review">
            <h2>Shape comments</h2>
            <p className="muted">
              {selected.length === 1
                ? `Selected shape: ${selected[0]}`
                : "Select one shape on the canvas to attach a comment."}
            </p>
            <form onSubmit={comment}>
              <label>
                Your name
                <input
                  aria-label="Your name"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  maxLength={100}
                />
              </label>
              <label>
                Comment on selected shape
                <textarea
                  aria-label="Shape comment"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={10000}
                />
              </label>
              <button
                disabled={
                  busy ||
                  dirty ||
                  !doc?.diagramId ||
                  selected.length !== 1 ||
                  !text.trim()
                }
              >
                Comment on shape
              </button>
            </form>
            {comments.map((c) => (
              <div className="record" key={c.id}>
                <strong>{c.authorName || "Reviewer"}</strong>
                <p>{c.text}</p>
                {c.anchor?.shapeId &&
                  !scene.current.elements.some(
                    (el) => el.id === c.anchor.shapeId && !el.isDeleted,
                  ) && <p className="changed">Shape removed</p>}
                {(c.replies || []).map((r, i) => (
                  <p key={r.id || i}>
                    <strong>
                      {r.authorName || (r.agent ? "Agent" : "Reply")}:{" "}
                    </strong>
                    {r.text}
                  </p>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.reply;
                    const content = input.value.trim();
                    if (!content) return;
                    run(async () => {
                      const res = await fetch(
                        `/api/feedback/${key}/${c.id}/reply`,
                        {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({
                            content: { text: content },
                            author: { displayName: author || "Anonymous" },
                            editToken: reviewerToken(),
                          }),
                        },
                      );
                      if (!res.ok) throw Error("Reply could not be saved.");
                      input.value = "";
                      const updated = await request(
                        `/${doc.diagramId}/comments`,
                      );
                      setComments(threads(updated.items || []));
                      notify("comment");
                    });
                  }}
                >
                  <input
                    name="reply"
                    aria-label="Reply to shape comment"
                    placeholder="Reply to this comment"
                  />
                  <button disabled={busy}>Reply</button>
                </form>
              </div>
            ))}
            <h2>Proposals</h2>
            {!doc?.proposals?.length && (
              <p className="muted">Proposed edits appear here for review.</p>
            )}
            {doc?.proposals?.map((p) => (
              <div className="record" key={p.proposalId}>
                <strong>{p.title}</strong>
                <p className="muted">
                  {p.status} · {p.summary}
                </p>
                {(p.svg || proposalPreviews[p.proposalId]) && (
                  <img
                    className="preview"
                    alt={`Proposal: ${p.title}`}
                    src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(p.svg || proposalPreviews[p.proposalId])))}`}
                  />
                )}
                <button
                  onClick={() =>
                    run(async () => {
                      const svg = await svgFor(p.scene);
                      setProposalPreviews((previous) => ({
                        ...previous,
                        [p.proposalId]: svg,
                      }));
                    })
                  }
                >
                  Preview proposal SVG
                </button>
                {p.status === "pending" && permissions.accept && (
                  <>
                    <button disabled={busy || dirty} onClick={() => accept(p)}>
                      Accept proposal
                    </button>
                    <button disabled={busy} onClick={() => reject(p)}>
                      Reject proposal
                    </button>
                  </>
                )}
              </div>
            ))}
            <h2>Revisions</h2>
            {doc?.revisions?.map((r) => (
              <div className="record" key={r.revisionId}>
                <strong>{r.title}</strong>
                <p className="muted">{r.summary || r.revisionId}</p>
                {r.svg && (
                  <img
                    className="preview"
                    alt={`Revision: ${r.title}`}
                    src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(r.svg)))}`}
                  />
                )}
                <button
                  disabled={busy}
                  onClick={() => exportRevision(r.revisionId, "excalidraw")}
                >
                  Export revision JSON
                </button>
                <button
                  disabled={busy}
                  onClick={() => exportRevision(r.revisionId, "svg")}
                >
                  Export revision SVG
                </button>
              </div>
            ))}
          </aside>
        )}
      </div>
      {mermaid && (
        <dialog
          inert={busy ? "" : undefined}
          ref={mermaidDialog}
          onCancel={() => setMermaid(false)}
          aria-label="Import Mermaid"
        >
          <h2>Import Mermaid as a new diagram</h2>
          <p>This creates editable shapes on a new canvas.</p>
          <textarea
            aria-label="Mermaid source"
            maxLength={50000}
            value={syntax}
            onChange={(e) => setSyntax(e.target.value)}
          />
          <button disabled={busy} onClick={importMermaid}>
            Create from Mermaid
          </button>{" "}
          <button onClick={() => setMermaid(false)}>Cancel</button>
        </dialog>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
