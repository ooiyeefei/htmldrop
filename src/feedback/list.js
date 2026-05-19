import { loadManifest } from '../manifest.js';

export async function feedbackList() {
  const manifest = loadManifest();
  const feedbackFiles = manifest.files.filter((f) => f.feedback && f.docId);

  if (feedbackFiles.length === 0) {
    console.log('No files with feedback enabled. Push with --feedback flag to enable.');
    return [];
  }

  console.log(`\nFiles with feedback enabled:\n`);
  for (const file of feedbackFiles) {
    console.log(`  ${file.name}  (docId: ${file.docId.slice(0, 8)}...)`);
  }
  console.log(`\n${feedbackFiles.length} file(s) total.`);
  return feedbackFiles;
}
