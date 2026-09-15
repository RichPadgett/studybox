import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import sqlite3 from "sqlite3";
import type {
  Recording,
  TranscriptChunk,
  TranscriptDocument,
  TranscriptEntity,
  TranscriptEntityOccurrence,
  TranscriptEntityRelationship,
  TranscriptJob,
  TranscriptLibraryState,
  TranscriptMarker,
  TranscriptSearchResult
} from "@studybox/shared";

export interface TranscriptLibraryOptions {
  rootDir: string;
  chunkSeconds?: number;
  ffmpegPath?: string;
  apiKey?: string;
  transcriptionModel?: string;
  analysisModel?: string;
}

interface StoredState {
  jobs: TranscriptJob[];
  documents: TranscriptDocument[];
}

const emptyState = (): StoredState => ({ jobs: [], documents: [] });

export class TranscriptLibraryService {
  private state: StoredState = emptyState();
  private processing = false;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly pendingSources = new Map<string, { recording: Recording; filePath: string }>();
  private db?: sqlite3.Database;

  constructor(private readonly options: TranscriptLibraryOptions) {}

  async load(): Promise<void> {
    await mkdir(this.options.rootDir, { recursive: true });
    this.db = await openDatabase(join(this.options.rootDir, "studybox.db"));
    await exec(this.db, `
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, recording_id TEXT NOT NULL UNIQUE, recording_title TEXT NOT NULL,
        status TEXT NOT NULL, progress_percent INTEGER NOT NULL, current_chunk INTEGER,
        chunk_count INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS documents (
        recording_id TEXT PRIMARY KEY, recording_uuid TEXT NOT NULL, source_file_uuid TEXT NOT NULL, source_file_sha256 TEXT NOT NULL,
        title TEXT, description TEXT, full_text_path TEXT NOT NULL,
        status TEXT NOT NULL, recorded_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, file_uuid TEXT NOT NULL, recording_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        start_seconds REAL NOT NULL, end_seconds REAL, audio_file_name TEXT NOT NULL,
        text TEXT, status TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recording_id TEXT NOT NULL,
        timestamp_seconds REAL NOT NULL, label TEXT NOT NULL, scripture TEXT, kind TEXT
      );
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, canonical_name TEXT NOT NULL,
        entity_type TEXT NOT NULL, aliases_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entity_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, recording_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL, timestamp_seconds REAL NOT NULL, quote TEXT NOT NULL,
        confidence REAL NOT NULL, source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entity_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
        relationship TEXT NOT NULL, recording_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
        evidence TEXT NOT NULL, confidence REAL NOT NULL, source TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(chunk_id UNINDEXED, recording_id UNINDEXED, text);
    `);
    await exec(this.db, "ALTER TABLE documents ADD COLUMN recorded_at TEXT").catch(() => undefined);
    const jobs = await all<Record<string, unknown>>(this.db, "SELECT * FROM jobs ORDER BY created_at DESC");
    const rows = await all<Record<string, unknown>>(this.db, "SELECT * FROM documents ORDER BY created_at DESC");
    const sourceNames = await this.loadSourceNames();
    this.state = { jobs: jobs.map(rowToJob).map(recoverJob), documents: [] };
    for (const row of rows) {
      const recordingId = String(row.recording_id);
      const chunks = await all<Record<string, unknown>>(this.db, "SELECT * FROM chunks WHERE recording_id = ? ORDER BY chunk_index", recordingId);
      const markers = await all<Record<string, unknown>>(this.db, "SELECT * FROM markers WHERE recording_id = ? ORDER BY timestamp_seconds", recordingId);
      const entities = await all<Record<string, unknown>>(this.db, "SELECT * FROM entities WHERE recording_id = ?", recordingId);
      const occurrences = await all<Record<string, unknown>>(this.db, "SELECT * FROM entity_occurrences WHERE recording_id = ? ORDER BY timestamp_seconds", recordingId);
      const relationships = await all<Record<string, unknown>>(this.db, "SELECT * FROM entity_relationships WHERE recording_id = ?", recordingId);
      this.state.documents.push({
        recordingId,
        recordingUuid: String(row.recording_uuid),
        sourceFileUuid: String(row.source_file_uuid),
        sourceFileSha256: String(row.source_file_sha256),
        sourceFileName: sourceNames.get(String(row.source_file_sha256)),
        title: row.title ? String(row.title) : undefined,
        description: row.description ? String(row.description) : undefined,
        fullTextPath: String(row.full_text_path),
        chunks: chunks.map(rowToChunk),
        markers: markers.map(rowToMarker),
        entities: entities.map(rowToEntity),
        occurrences: occurrences.map(rowToOccurrence),
        relationships: relationships.map(rowToRelationship),
        status: String(row.status) as TranscriptDocument["status"],
        recordedAt: row.recorded_at ? String(row.recorded_at) : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        error: row.error ? String(row.error) : undefined
      });
    }
    if (this.state.jobs.length === 0 && this.state.documents.length === 0) {
      await this.importLegacyJson();
    }
    await this.save();
  }

  getState(): TranscriptLibraryState {
    return {
      enabled: Boolean(this.options.apiKey),
      rootDir: this.options.rootDir,
      jobs: this.state.jobs.slice(0, 25),
      documents: this.state.documents.slice(0, 50),
      lastEvent: this.state.jobs[0]?.error ?? this.state.jobs[0]?.status
    };
  }

  getJob(recordingId: string): TranscriptJob | undefined {
    return this.state.jobs.find((job) => job.recordingId === recordingId);
  }

  async recoverTranscript(recording: Recording, sourcePath: string): Promise<boolean> {
    if (!this.db) throw new Error("Transcript library is not loaded");
    const workDir = join(this.options.rootDir, recording.id);
    const fullTextPath = join(workDir, "transcript.txt");
    let fullText: string;
    try {
      fullText = await readFile(fullTextPath, "utf8");
    } catch {
      return false;
    }

    const chunkFiles = (await readdir(workDir)).filter((name) => name === `${recording.id}-chunk-0.json` || new RegExp(`^${recording.id}-chunk-\\d+\\.json$`).test(name));
    if (!chunkFiles.length) return false;
    const chunks = [];
    for (const fileName of chunkFiles) {
      chunks.push(JSON.parse(await readFile(join(workDir, fileName), "utf8")) as TranscriptChunk);
    }
    chunks.sort((a, b) => a.index - b.index);
    const now = new Date().toISOString();
    const document: TranscriptDocument = {
      recordingId: recording.id,
      recordingUuid: randomUUID(),
      sourceFileUuid: randomUUID(),
      sourceFileSha256: await hashFile(sourcePath),
      title: recording.title,
      description: "Transcript recovered. AI summary and topic analysis are pending.",
      fullTextPath,
      chunks,
      markers: [],
      entities: [],
      occurrences: [],
      relationships: [],
      status: "completed",
      createdAt: now,
      updatedAt: now
    };
    this.state.documents = [document, ...this.state.documents.filter((candidate) => candidate.recordingId !== recording.id)];
    const job = this.getJob(recording.id);
    if (job) await this.updateJob(job, { status: "completed", progressPercent: 100, error: undefined });
    await this.save();
    return true;
  }

  async reanalyze(recordingId: string): Promise<boolean> {
    const document = this.getDocument(recordingId);
    if (!document) return false;
    const fullText = await this.readFullText(recordingId);
    if (!fullText) return false;
    const analysis = namespaceAnalysis(recordingId, await this.analyze({
      id: recordingId,
      title: document.title ?? recordingId,
      startedAt: document.createdAt,
      durationSeconds: 0,
      sizeBytes: 0
    }, fullText));
    document.title = analysis.title ?? document.title;
    document.description = analysis.description;
    document.markers = analysis.markers;
    document.entities = analysis.entities;
    document.occurrences = analysis.occurrences.map((occurrence) => ({
      ...occurrence,
      recordingId,
      chunkId: normalizeChunkId(recordingId, occurrence.chunkId)
    }));
    document.relationships = analysis.relationships.map((relationship) => ({
      ...relationship,
      recordingId,
      chunkId: normalizeChunkId(recordingId, relationship.chunkId)
    }));
    document.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async enqueue(recording: Recording, filePath: string): Promise<TranscriptJob> {
    const existing = this.state.jobs.find((job) => job.recordingId === recording.id);
    if (existing && existing.status !== "failed") {
      this.pendingSources.set(recording.id, { recording, filePath });
      void this.processQueue();
      return existing;
    }

    const now = new Date().toISOString();
    const job: TranscriptJob = {
      id: existing?.id ?? `transcript-${recording.id}`,
      recordingId: recording.id,
      recordingTitle: recording.title,
      status: "queued",
      progressPercent: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      error: undefined
    };
    this.state.jobs = [job, ...this.state.jobs.filter((candidate) => candidate.id !== job.id)];
    this.pendingSources.set(recording.id, { recording, filePath });
    await this.save();
    void this.processQueue();
    return job;
  }

  async retry(recordingId: string, recording: Recording, filePath: string): Promise<TranscriptJob> {
    this.state.jobs = this.state.jobs.filter((job) => job.recordingId !== recordingId);
    this.state.documents = this.state.documents.filter((document) => document.recordingId !== recordingId);
    await this.save();
    return this.enqueue(recording, filePath);
  }

  async processPending(recordings: Recording[], resolveFile: (recording: Recording) => string | undefined): Promise<void> {
    for (const job of this.state.jobs.filter((candidate) => candidate.status !== "completed")) {
      const recording = recordings.find((candidate) => candidate.id === job.recordingId);
      if (!recording) continue;
      const filePath = resolveFile(recording);
      if (!filePath) continue;
      await this.enqueue(recording, filePath);
    }
  }

  async search(query: string, limit = 30): Promise<TranscriptSearchResult[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    if (!this.db) return [];
    const matchQuery = terms.map((term) => term.replace(/[^a-z0-9_]/gi, "")).filter(Boolean).join(" AND ");
    if (!matchQuery) return [];
    const rows = await all<Record<string, unknown>>(this.db, `
      SELECT f.chunk_id, f.recording_id, f.text, c.start_seconds, d.title
      FROM transcript_fts f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN documents d ON d.recording_id = f.recording_id
      WHERE transcript_fts MATCH ?
      ORDER BY bm25(transcript_fts)
      LIMIT ?
    `, matchQuery, limit);
    const results: TranscriptSearchResult[] = [];
    for (const row of rows) {
      const text = String(row.text);
      const timestampSeconds = Number(row.start_seconds);
      const recordingId = String(row.recording_id);
      const document = this.getDocument(recordingId);
      const firstTerm = text.toLowerCase().indexOf(terms[0]);
      const start = Math.max(0, firstTerm - 120);
      results.push({
        recordingId,
        recordingTitle: row.title ? String(row.title) : recordingId,
        timestampSeconds,
        timestampLabel: formatTimestamp(timestampSeconds),
        snippet: `${start > 0 ? "..." : ""}${text.slice(start, start + 360).trim()}${start + 360 < text.length ? "..." : ""}`,
        scripture: document ? nearestScripture(document.markers, timestampSeconds) : undefined
      });
    }
    return results;
  }

  getDocument(recordingId: string): TranscriptDocument | undefined {
    return this.state.documents.find((document) => document.recordingId === recordingId);
  }

  async readFullText(recordingId: string): Promise<string | undefined> {
    const document = this.getDocument(recordingId);
    if (!document) return undefined;
    try {
      return await readFile(document.fullTextPath, "utf8");
    } catch {
      return undefined;
    }
  }

  getAudioChunkPath(recordingId: string, chunkIndex: number): string | undefined {
    const document = this.getDocument(recordingId);
    const chunk = document?.chunks.find((candidate) => candidate.index === chunkIndex);
    return chunk ? join(this.options.rootDir, recordingId, chunk.audioFileName) : undefined;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const next = this.state.jobs.find((candidate) => candidate.status === "queued" && this.pendingSources.has(candidate.recordingId));
        if (!next) return;
        const source = this.pendingSources.get(next.recordingId);
        if (!source) continue;
        await this.processOne(next, source.recording, source.filePath);
        this.pendingSources.delete(next.recordingId);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processOne(job: TranscriptJob, recording: Recording, sourcePath: string): Promise<void> {
    try {
      if (!this.options.apiKey) throw new Error("OPENAI_API_KEY is not configured");
      await this.updateJob(job, { status: "chunking", progressPercent: 2 });
      const workDir = join(this.options.rootDir, recording.id);
      await mkdir(workDir, { recursive: true });
      const sourceFileUuid = randomUUID();
      const sourceFileSha256 = await hashFile(sourcePath);
      const recordingUuid = randomUUID();
      const chunkFiles = await this.chunkAudio(sourcePath, workDir);
      const chunks: TranscriptChunk[] = chunkFiles.map((fileName, index) => ({
        id: `${recording.id}-chunk-${index}`,
        fileUuid: randomUUID(),
        index,
        startSeconds: index * (this.options.chunkSeconds ?? 600),
        audioFileName: fileName,
        status: "pending"
      }));
      job.chunkCount = chunks.length;
      await this.updateJob(job, { status: "transcribing", progressPercent: 5, chunkCount: chunks.length });
      const transcriptParts: string[] = [];
      for (const chunk of chunks) {
        try {
          chunk.text = await this.transcribe(join(workDir, chunk.audioFileName));
          chunk.status = "transcribed";
          transcriptParts.push(`[${formatTimestamp(chunk.startSeconds)}]\n${chunk.text}`);
          await writeFile(join(workDir, `${chunk.id}.json`), JSON.stringify(chunk, null, 2));
          await this.updateJob(job, {
            currentChunk: chunk.index + 1,
            progressPercent: 5 + Math.round(((chunk.index + 1) / chunks.length) * 75)
          });
        } catch (error) {
          chunk.status = "failed";
          chunk.error = error instanceof Error ? error.message : String(error);
          throw new Error(`Chunk ${chunk.index + 1} failed: ${chunk.error}`);
        }
      }

      const fullTextPath = join(workDir, "transcript.txt");
      const fullText = transcriptParts.join("\n\n");
      await writeFile(fullTextPath, fullText);
      await this.updateJob(job, { status: "analyzing", progressPercent: 85 });
      const analysis = namespaceAnalysis(recording.id, await this.analyze(recording, fullText));
      const occurrences = analysis.occurrences.map((occurrence) => ({
        ...occurrence,
        recordingId: recording.id,
        chunkId: normalizeChunkId(recording.id, occurrence.chunkId)
      }));
      const relationships = analysis.relationships.map((relationship) => ({
        ...relationship,
        recordingId: recording.id,
        chunkId: normalizeChunkId(recording.id, relationship.chunkId)
      }));
      const document: TranscriptDocument = {
        recordingId: recording.id,
        recordingUuid,
        sourceFileUuid,
        sourceFileSha256,
        title: analysis.title,
        description: analysis.description,
        markers: analysis.markers,
        fullTextPath,
        chunks,
        entities: analysis.entities,
        occurrences,
        relationships,
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.state.documents = [document, ...this.state.documents.filter((candidate) => candidate.recordingId !== recording.id)];
      await this.updateJob(job, { status: "completed", progressPercent: 100 });
      await this.save();
    } catch (error) {
      await this.updateJob(job, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      console.error(`Transcript job failed for ${recording.id}`, error);
    }
  }

  private async chunkAudio(sourcePath: string, workDir: string): Promise<string[]> {
    const existing = (await readdir(workDir)).filter((name) => /^chunk-\d{3}\.m4a$/.test(name)).sort();
    if (existing.length) return existing;
    const outputPattern = join(workDir, "chunk-%03d.m4a");
    await runProcess(this.options.ffmpegPath ?? "ffmpeg", ["-y", "-i", sourcePath, "-vn", "-c:a", "aac", "-b:a", "96k", "-f", "segment", "-segment_time", String(this.options.chunkSeconds ?? 600), outputPattern]);
    return (await readdir(workDir)).filter((name) => /^chunk-\d{3}\.m4a$/.test(name)).sort();
  }

  private async transcribe(filePath: string): Promise<string> {
    const body = new FormData();
    body.append("file", new Blob([await readFile(filePath)], { type: "audio/mp4" }), basename(filePath));
    body.append("model", this.options.transcriptionModel ?? "gpt-4o-transcribe");
    body.append("response_format", "json");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      body
    });
    const payload = await response.json() as { text?: string; error?: { message?: string } };
    if (!response.ok || !payload.text) throw new Error(payload.error?.message ?? `Transcription failed (${response.status})`);
    return payload.text.trim();
  }

  private async analyze(recording: Recording, fullText: string): Promise<{ title?: string; description?: string; markers: TranscriptMarker[]; entities: TranscriptEntity[]; occurrences: TranscriptEntityOccurrence[]; relationships: TranscriptEntityRelationship[] }> {
    const prompt = `Create a podcast package and searchable knowledge index for this Bible study recording. Return JSON only with keys title, description, markers, entities, occurrences, relationships.
markers: array of {timestampSeconds, label, scripture?, kind} using approximately each 10-minute boundary plus major transitions. Never invent Scripture references.
entities: canonical entities with {id, canonicalName, type, aliases}; types are person, place, event, topic, scripture, organization, term.
occurrences: references to entities with {entityId, chunkId, timestampSeconds, quote, confidence, source}. Use chunkId values chunk-0, chunk-1, etc. Keep only useful terms and Scripture references.
relationships: meaningful cross-references with {fromEntityId, toEntityId, relationship, chunkId, evidence, confidence, source}. Only include relationships supported by the transcript.
Recording title: ${recording.title}\nTranscript:\n${fullText.slice(0, 220000)}`;
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.options.analysisModel ?? "gpt-5-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You produce accurate, concise podcast metadata from transcripts." },
          { role: "user", content: prompt }
        ]
      })
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? `Analysis failed (${response.status})`);
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Analysis returned no content");
    const parsed = JSON.parse(content) as Partial<{ title: string; description: string; markers: TranscriptMarker[]; entities: TranscriptEntity[]; occurrences: TranscriptEntityOccurrence[]; relationships: TranscriptEntityRelationship[] }>;
    return {
      title: parsed.title?.trim(),
      description: parsed.description?.trim(),
      markers: Array.isArray(parsed.markers) ? parsed.markers.filter((marker) => typeof marker.timestampSeconds === "number" && typeof marker.label === "string").sort((a, b) => a.timestampSeconds - b.timestampSeconds) : [],
      entities: Array.isArray(parsed.entities) ? parsed.entities.filter((entity) => typeof entity.id === "string" && typeof entity.canonicalName === "string") : [],
      occurrences: Array.isArray(parsed.occurrences) ? parsed.occurrences.filter((occurrence) => typeof occurrence.entityId === "string" && typeof occurrence.chunkId === "string" && typeof occurrence.quote === "string") : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships.filter((relationship) => typeof relationship.fromEntityId === "string" && typeof relationship.toEntityId === "string" && typeof relationship.relationship === "string") : []
    };
  }

  private async updateJob(job: TranscriptJob, update: Partial<TranscriptJob>): Promise<void> {
    Object.assign(job, update, { updatedAt: new Date().toISOString() });
    await this.save();
  }

  private async loadSourceNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const history = await readFile(join(this.options.rootDir, "media-import-history.jsonl"), "utf8");
      for (const line of history.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { sha256?: string; fileName?: string };
          if (entry.sha256 && entry.fileName) names.set(entry.sha256, entry.fileName);
        } catch {
          // Ignore malformed history lines and keep loading the library.
        }
      }
    } catch {
      // Imported filenames are optional metadata.
    }
    return names;
  }

  private async importLegacyJson(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(join(this.options.rootDir, "library.json"), "utf8")) as Partial<StoredState>;
      if (Array.isArray(raw.jobs)) this.state.jobs = raw.jobs.map(recoverJob);
      if (Array.isArray(raw.documents)) {
        this.state.documents = raw.documents.map((document) => ({
          ...document,
          recordingUuid: document.recordingUuid ?? randomUUID(),
          sourceFileUuid: document.sourceFileUuid ?? randomUUID(),
          sourceFileSha256: document.sourceFileSha256 ?? "legacy-unknown",
          chunks: document.chunks.map((chunk) => ({ ...chunk, fileUuid: chunk.fileUuid ?? randomUUID() }))
        }));
      }
    } catch {
      // No prototype index exists; the SQLite database starts empty.
    }
  }

  private async save(): Promise<void> {
    const operation = this.saveChain.then(() => this.saveUnlocked());
    this.saveChain = operation.catch(() => undefined);
    await operation;
  }

  private async saveUnlocked(): Promise<void> {
    if (!this.db) return;
    await run(this.db, "BEGIN TRANSACTION");
    try {
      await exec(this.db, "DELETE FROM jobs; DELETE FROM documents; DELETE FROM chunks; DELETE FROM markers; DELETE FROM entities; DELETE FROM entity_occurrences; DELETE FROM entity_relationships; DELETE FROM transcript_fts;");
      for (const job of this.state.jobs) {
        await run(this.db, "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", job.id, job.recordingId, job.recordingTitle, job.status, job.progressPercent, job.currentChunk ?? null, job.chunkCount ?? null, job.createdAt, job.updatedAt, job.error ?? null);
      }
      for (const document of this.state.documents) {
        await run(this.db, "INSERT INTO documents (recording_id, recording_uuid, source_file_uuid, source_file_sha256, title, description, full_text_path, status, created_at, updated_at, error, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", document.recordingId, document.recordingUuid, document.sourceFileUuid, document.sourceFileSha256, document.title ?? null, document.description ?? null, document.fullTextPath, document.status, document.createdAt, document.updatedAt, document.error ?? null, document.recordedAt ?? null);
        for (const chunk of document.chunks) {
          await run(this.db, "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", chunk.id, chunk.fileUuid, document.recordingId, chunk.index, chunk.startSeconds, chunk.endSeconds ?? null, chunk.audioFileName, chunk.text ?? null, chunk.status, chunk.error ?? null);
          if (chunk.text) await run(this.db, "INSERT INTO transcript_fts VALUES (?, ?, ?)", chunk.id, document.recordingId, chunk.text);
        }
        for (const marker of document.markers) {
          await run(this.db, "INSERT INTO markers (recording_id, timestamp_seconds, label, scripture, kind) VALUES (?, ?, ?, ?, ?)", document.recordingId, marker.timestampSeconds, marker.label, marker.scripture ?? null, marker.kind ?? null);
        }
        for (const entity of document.entities ?? []) {
          await run(this.db, "INSERT INTO entities VALUES (?, ?, ?, ?, ?)", entity.id, document.recordingId, entity.canonicalName, entity.type, JSON.stringify(entity.aliases ?? []));
        }
        for (const occurrence of document.occurrences ?? []) {
          await run(this.db, "INSERT INTO entity_occurrences (entity_id, recording_id, chunk_id, timestamp_seconds, quote, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)", occurrence.entityId, document.recordingId, occurrence.chunkId, occurrence.timestampSeconds, occurrence.quote, occurrence.confidence ?? 0, occurrence.source ?? "ai");
        }
        for (const relationship of document.relationships ?? []) {
          await run(this.db, "INSERT INTO entity_relationships (from_entity_id, to_entity_id, relationship, recording_id, chunk_id, evidence, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", relationship.fromEntityId, relationship.toEntityId, relationship.relationship, document.recordingId, relationship.chunkId, relationship.evidence, relationship.confidence ?? 0, relationship.source ?? "ai");
        }
      }
      await run(this.db, "COMMIT");
    } catch (error) {
      await run(this.db, "ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

function namespaceAnalysis(recordingId: string, analysis: Awaited<ReturnType<TranscriptLibraryService["analyze"]>>): Awaited<ReturnType<TranscriptLibraryService["analyze"]>> {
  const entityIds = new Map(analysis.entities.map((entity) => [entity.id, `${recordingId}:${entity.id}`]));
  return {
    ...analysis,
    entities: analysis.entities.map((entity) => ({ ...entity, id: entityIds.get(entity.id) ?? entity.id })),
    occurrences: analysis.occurrences.map((occurrence) => ({
      ...occurrence,
      entityId: entityIds.get(occurrence.entityId) ?? `${recordingId}:${occurrence.entityId}`
    })),
    relationships: analysis.relationships.map((relationship) => ({
      ...relationship,
      fromEntityId: entityIds.get(relationship.fromEntityId) ?? `${recordingId}:${relationship.fromEntityId}`,
      toEntityId: entityIds.get(relationship.toEntityId) ?? `${recordingId}:${relationship.toEntityId}`
    }))
  };
}

function recoverJob(job: TranscriptJob): TranscriptJob {
  return job.status === "completed" ? job : { ...job, status: "queued", error: undefined };
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-500) || `${command} exited ${code}`)));
  });
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function nearestScripture(markers: TranscriptMarker[], seconds: number): string | undefined {
  return markers.filter((marker) => marker.scripture).sort((a, b) => Math.abs(a.timestampSeconds - seconds) - Math.abs(b.timestampSeconds - seconds))[0]?.scripture;
}

function openDatabase(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(database));
  });
}

function run(database: sqlite3.Database, sql: string, ...params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => error ? reject(error) : resolve());
  });
}

function exec(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => error ? reject(error) : resolve());
  });
}

function all<T>(database: sqlite3.Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[]));
  });
}

function rowToJob(row: Record<string, unknown>): TranscriptJob {
  return {
    id: String(row.id), recordingId: String(row.recording_id), recordingTitle: String(row.recording_title),
    status: String(row.status) as TranscriptJob["status"], progressPercent: Number(row.progress_percent),
    currentChunk: row.current_chunk == null ? undefined : Number(row.current_chunk),
    chunkCount: row.chunk_count == null ? undefined : Number(row.chunk_count),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), error: row.error ? String(row.error) : undefined
  };
}

function rowToChunk(row: Record<string, unknown>): TranscriptChunk {
  return {
    id: String(row.id), fileUuid: String(row.file_uuid), index: Number(row.chunk_index), startSeconds: Number(row.start_seconds),
    endSeconds: row.end_seconds == null ? undefined : Number(row.end_seconds), audioFileName: String(row.audio_file_name),
    text: row.text ? String(row.text) : undefined, status: String(row.status) as TranscriptChunk["status"], error: row.error ? String(row.error) : undefined
  };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await readFile(filePath);
  hash.update(file);
  return hash.digest("hex");
}

function rowToMarker(row: Record<string, unknown>): TranscriptMarker {
  return {
    timestampSeconds: Number(row.timestamp_seconds), label: String(row.label), scripture: row.scripture ? String(row.scripture) : undefined,
    kind: row.kind ? String(row.kind) as TranscriptMarker["kind"] : undefined
  };
}

function rowToEntity(row: Record<string, unknown>): TranscriptEntity {
  let aliases: string[] = [];
  try { aliases = JSON.parse(String(row.aliases_json)) as string[]; } catch { aliases = []; }
  return { id: String(row.id), canonicalName: String(row.canonical_name), type: String(row.entity_type) as TranscriptEntity["type"], aliases };
}

function rowToOccurrence(row: Record<string, unknown>): TranscriptEntityOccurrence {
  return {
    entityId: String(row.entity_id), recordingId: String(row.recording_id), chunkId: String(row.chunk_id),
    timestampSeconds: Number(row.timestamp_seconds), quote: String(row.quote), confidence: Number(row.confidence),
    source: String(row.source) as TranscriptEntityOccurrence["source"]
  };
}

function rowToRelationship(row: Record<string, unknown>): TranscriptEntityRelationship {
  return {
    fromEntityId: String(row.from_entity_id), toEntityId: String(row.to_entity_id), relationship: String(row.relationship) as TranscriptEntityRelationship["relationship"],
    recordingId: String(row.recording_id), chunkId: String(row.chunk_id), evidence: String(row.evidence), confidence: Number(row.confidence),
    source: String(row.source) as TranscriptEntityRelationship["source"]
  };
}

function normalizeChunkId(recordingId: string, chunkId: string): string {
  const match = chunkId.match(/^chunk-(\d+)$/);
  return match ? `${recordingId}-chunk-${Number(match[1])}` : chunkId;
}
