import { TranscriptLibraryService } from "/opt/studybox/services/transcripts/dist/index.js";

const library = new TranscriptLibraryService({
  rootDir: process.env.STUDYBOX_LIBRARY_DIR ?? "/var/lib/studybox/library",
  apiKey: process.env.OPENAI_API_KEY,
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL,
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL
});
await library.load();

const documents = [...library.getState().documents];
let completed = 0;
for (const document of documents) {
  try {
    console.log(`ANALYZE ${document.recordingId}`);
    if (await library.reanalyze(document.recordingId)) completed += 1;
  } catch (error) {
    console.error(`FAILED ${document.recordingId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(JSON.stringify({ attempted: documents.length, completed }, null, 2));
