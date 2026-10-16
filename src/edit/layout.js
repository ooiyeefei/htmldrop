import { createHash } from 'node:crypto';

function viewportOf(value = {}) {
  const width = Number(value.width) || 0;
  const height = Number(value.height) || 0;
  return { width, height, dpr: Number(value.dpr) || 1,
    bucket: width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop' };
}

function sameViewport(a, b) {
  return a && a.width === b.width && a.height === b.height && a.dpr === b.dpr;
}

// Identity excludes changing measurements and copy. A complete check only clears
// evidence measured at the exact same dimensions, including pixel density.
export function reconcileLayout(previous = {}, warnings, docHash, meta = {}) {
  previous ||= {};
  const at = new Date().toISOString();
  const viewport = viewportOf(meta.viewport);
  const sourceHash = typeof meta.sourceHash === 'string' ? meta.sourceHash : undefined;
  const renderRevision = typeof meta.renderRevision === 'string' ? meta.renderRevision : sourceHash;
  const complete = meta.complete === true && !!sourceHash && viewport.width > 0 && viewport.height > 0 && Array.isArray(warnings) && warnings.length <= 100;
  const current = Array.isArray(warnings) ? warnings.slice(0, 100) : [];
  const issues = (previous.issues || []).map((i) => ({ ...i }));
  const detected = new Set();
  for (const warning of current) {
    if (!warning || typeof warning.kind !== 'string' || typeof warning.selector !== 'string') continue;
    const id = createHash('sha256').update(JSON.stringify([
      warning.kind, warning.selector, viewport.bucket,
      viewport.width, viewport.height, viewport.dpr,
    ])).digest('hex').slice(0, 20);
    detected.add(id);
    let issue = issues.find((i) => i.id === id);
    if (!issue) {
      issue = { id, firstSeenAt: at, status: 'open' };
      issues.push(issue);
    }
    const revised = issue.sourceHash !== sourceHash || (issue.renderRevision || issue.sourceHash) !== renderRevision;
    const ignored = issue.status === 'ignored' && !!sourceHash && issue.ignoredSourceHash === sourceHash && (issue.ignoredRenderRevision || issue.ignoredSourceHash) === renderRevision;
    if (revised) issue.pendingRepair = false;
    Object.assign(issue, warning, { id, viewport, sourceHash, renderRevision, lastSeenAt: at,
      status: ignored ? 'ignored' : !complete ? 'unverified' : issue.pendingRepair ? 'queued' : 'open' });
    delete issue.resolvedAt;
  }
  for (const issue of issues) {
    if (detected.has(issue.id)) continue;
    const sourceChanged = issue.sourceHash !== sourceHash || (issue.renderRevision || issue.sourceHash) !== renderRevision;
    if (issue.status === 'ignored' && !sourceChanged) continue;
    if (complete && sameViewport(issue.viewport, viewport)) {
      issue.status = 'resolved';
      issue.resolvedAt = at;
      issue.resolvedSourceHash = sourceHash;
      issue.resolvedRenderRevision = renderRevision;
      issue.pendingRepair = false;
    } else if (issue.status !== 'resolved' && (sourceChanged || sameViewport(issue.viewport, viewport))) {
      if (issue.status !== 'ignored' || sourceChanged) issue.status = 'unverified';
    }
  }
  return { warnings: current, docHash: docHash || undefined, at, issues, sourceHash, renderRevision, viewport, complete,
    reason: complete ? undefined : (meta.reason || 'Check incomplete or source/viewport unavailable') };
}
