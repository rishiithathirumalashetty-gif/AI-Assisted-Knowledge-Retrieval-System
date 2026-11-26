/**
 * Retrieval-Augmented Generation (RAG) pipeline
 * ---------------------------------------------
 * 1. Extract text from an uploaded document (PDF via pdf-parse, other files as UTF-8 text).
 * 2. Split the text into overlapping chunks.
 * 3. Turn every chunk into an embedding vector with a local Ollama embedding model.
 * 4. Store the vectors in a small JSON vector store on disk.
 * 5. For a question, embed the question and return the most similar chunks (cosine similarity).
 *
 * Everything runs locally. No document text leaves the machine.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { PDFParse } = require("pdf-parse");

const CHUNK_SIZE = 1000;   // characters per chunk
const CHUNK_OVERLAP = 200; // characters shared by neighbouring chunks
const EMBED_BATCH = 16;    // chunks per embedding request

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Return the plain text of a file. PDFs are parsed, everything else is read as UTF-8. */
async function extractText(filePath) {
    if (path.extname(filePath).toLowerCase() === ".pdf") {
        const parser = new PDFParse({ data: fs.readFileSync(filePath) });
        try {
            const result = await parser.getText();
            // pdf-parse adds "-- 1 of 3 --" page markers; they carry no content.
            return (result.text || "").replace(/^-- \d+ of \d+ --$/gm, "").trim();
        } finally {
            await parser.destroy();
        }
    }
    return fs.readFileSync(filePath, "utf8");
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split text into chunks of about `size` characters, each overlapping the previous one by
 * `overlap` characters. Chunk ends are moved back to the nearest whitespace so words are not cut.
 */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    if (overlap >= size) throw new Error("overlap must be smaller than size");
    const clean = String(text).replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const chunks = [];
    let start = 0;
    while (start < clean.length) {
        let end = Math.min(start + size, clean.length);
        if (end < clean.length) {
            const space = clean.lastIndexOf(" ", end);
            const newline = clean.lastIndexOf("\n", end);
            const cut = Math.max(space, newline);
            if (cut > start + size / 2) end = cut;
        }
        const piece = clean.slice(start, end).trim();
        if (piece) chunks.push(piece);
        if (end >= clean.length) break;
        start = end - overlap;
    }
    return chunks;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

class RagStore {
    /**
     * @param {object} opts
     * @param {string} opts.knowledgeDir folder with the uploaded documents
     * @param {string} opts.storePath    JSON file that holds the vectors
     * @param {string} opts.ollamaUrl    base URL of Ollama
     * @param {string} opts.embedModel   Ollama embedding model, e.g. nomic-embed-text
     */
    constructor({ knowledgeDir, storePath, ollamaUrl, embedModel }) {
        this.knowledgeDir = knowledgeDir;
        this.storePath = storePath;
        this.ollamaUrl = ollamaUrl;
        this.embedModel = embedModel;
        this.files = {}; // fileName -> { mtimeMs, size, chunks: [{ text, embedding }] }
        this.load();
    }

    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
            if (data.embedModel === this.embedModel && data.files) this.files = data.files;
        } catch (err) { /* no store yet */ }
    }

    save() {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        const tmp = this.storePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ embedModel: this.embedModel, files: this.files }));
        fs.renameSync(tmp, this.storePath);
    }

    /** Embed a list of texts with Ollama. Throws a readable error if Ollama or the model is missing. */
    async embed(texts) {
        const vectors = [];
        for (let i = 0; i < texts.length; i += EMBED_BATCH) {
            const batch = texts.slice(i, i + EMBED_BATCH);
            let res;
            try {
                res = await axios.post(
                    `${this.ollamaUrl}/api/embed`,
                    { model: this.embedModel, input: batch },
                    { timeout: 120000 }
                );
            } catch (err) {
                const e = new Error(
                    err.response && err.response.status === 404
                        ? `Embedding model "${this.embedModel}" is not available. Run: ollama pull ${this.embedModel}`
                        : `Could not create embeddings with Ollama (${err.code || err.message}).`
                );
                e.cause = err;
                throw e;
            }
            const out = res.data && res.data.embeddings;
            if (!Array.isArray(out) || out.length !== batch.length) {
                throw new Error("Ollama returned no embeddings. Check the embedding model.");
            }
            vectors.push(...out);
        }
        return vectors;
    }

    /** Extract, chunk, embed and store one document. Replaces any earlier version of it. */
    async indexFile(fileName) {
        const filePath = path.join(this.knowledgeDir, fileName);
        const stat = fs.statSync(filePath);
        const text = await extractText(filePath);
        const pieces = chunkText(text);
        const embeddings = pieces.length ? await this.embed(pieces) : [];
        this.files[fileName] = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            chunks: pieces.map((t, i) => ({ text: t, embedding: embeddings[i] }))
        };
        this.save();
        return { fileName, chunks: pieces.length, characters: text.length };
    }

    removeFile(fileName) {
        if (this.files[fileName]) {
            delete this.files[fileName];
            this.save();
        }
    }

    /**
     * Index new or changed files and drop files that were deleted from the knowledge folder.
     * Returns a summary; errors for single files are collected instead of thrown.
     */
    async sync() {
        const present = fs.readdirSync(this.knowledgeDir).filter((f) => !f.startsWith("."));
        const indexed = [], errors = [];
        for (const name of Object.keys(this.files)) {
            if (!present.includes(name)) delete this.files[name];
        }
        for (const name of present) {
            const stat = fs.statSync(path.join(this.knowledgeDir, name));
            const known = this.files[name];
            if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue;
            try {
                indexed.push(await this.indexFile(name));
            } catch (err) {
                errors.push({ fileName: name, error: err.message });
            }
        }
        this.save();
        return { indexed, errors };
    }

    get chunkCount() {
        return Object.values(this.files).reduce((n, f) => n + f.chunks.length, 0);
    }

    chunksFor(fileName) {
        return this.files[fileName] ? this.files[fileName].chunks.length : 0;
    }

    /**
     * Semantic search: embed the question and return the `topK` chunks with the highest cosine
     * similarity that also reach `minScore`.
     */
    async search(question, topK = 4, minScore = 0.3) {
        if (!this.chunkCount) return [];
        const [q] = await this.embed([question]);
        const scored = [];
        for (const [file, entry] of Object.entries(this.files)) {
            entry.chunks.forEach((c, index) => {
                scored.push({ file, chunk: index + 1, text: c.text, score: cosineSimilarity(q, c.embedding) });
            });
        }
        return scored
            .filter((s) => s.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
}

module.exports = { RagStore, extractText, chunkText, cosineSimilarity, CHUNK_SIZE, CHUNK_OVERLAP };
