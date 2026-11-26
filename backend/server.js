/**
 * AI-Assisted Knowledge Retrieval System - backend
 * ------------------------------------------------
 * A small Express API that sits between the Angular frontend and a locally
 * running Ollama model.
 *
 *   POST /upload   save a document (PDF, text or code) and index it for RAG
 *   POST /chat     answer a question (optionally explaining one uploaded file)
 *   GET  /files    list the files in the knowledge folder
 *   POST /reindex  rebuild the vector index for every file in the knowledge folder
 *   GET  /health   report whether the server and Ollama are reachable
 *
 * Retrieval-Augmented Generation (see rag.js): documents are split into overlapping
 * chunks, embedded with a local Ollama embedding model and stored in a JSON vector
 * store. A question is embedded the same way and the most similar chunks are given
 * to the chat model as context. If no embeddings are available (embedding model not
 * pulled, Ollama down while uploading) the server falls back to keyword search.
 * Everything runs locally, so no document leaves the machine.
 *
 * Configuration (all optional) is read from environment variables, see
 * .env.example: PORT, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_EMBED_MODEL, OLLAMA_TIMEOUT_MS, CORS_ORIGIN,
 * KNOWLEDGE_DIR, VECTOR_STORE, RAG_TOP_K, RAG_MIN_SCORE.
 */
"use strict";

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { RagStore, extractText } = require("./rag");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Read backend/.env if it exists. Variables already set in the shell take precedence.
try {
    process.loadEnvFile(path.join(__dirname, ".env"));
} catch (err) {
    if (err.code !== "ENOENT") console.error(`Could not read .env: ${err.message}`);
}

const PORT = Number(process.env.PORT) || 3000;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:4200";
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, "knowledge");
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const VECTOR_STORE = process.env.VECTOR_STORE || path.join(KNOWLEDGE_DIR, ".vector-store.json");
const RAG_TOP_K = Number(process.env.RAG_TOP_K) || 4;            // chunks sent to the model
// Minimum cosine similarity. Measured with nomic-embed-text: questions answered by a document
// scored 0.62-0.84, unrelated questions 0.33-0.42, so 0.5 keeps the first and drops the second.
const RAG_MIN_SCORE = Number(process.env.RAG_MIN_SCORE) || 0.5;

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;     // 2 MB per text/code file
const MAX_PDF_BYTES = 10 * 1024 * 1024;       // 10 MB per PDF
const CHUNK_SIZE = 5000;                  // characters per searchable chunk
const TOP_CHUNKS = 3;                     // best-matching chunks sent to the model
const MAX_FILE_CONTEXT = 12000;           // characters of an uploaded file sent to the model
const MAX_QUESTION_LENGTH = 2000;
// A 7B model on a laptop CPU can need several minutes for a long answer.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 600000;

// Only plain-text source and document files are accepted.
const ALLOWED_EXTENSIONS = new Set([
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".java", ".js", ".ts", ".py", ".go", ".rs",
    ".html", ".css", ".json", ".xml", ".yml", ".yaml", ".sql", ".sh", ".s", ".asm", ".ino",
    ".md", ".txt", ".pdf"
]);

const STOP_WORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was",
    "one", "our", "out", "has", "have", "how", "what", "why", "when", "who", "does", "this",
    "that", "with", "from", "they", "will", "would", "there", "their", "which", "about",
    "into", "than", "then", "them", "these", "those", "your", "explain", "tell", "give"
]);

if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

const rag = new RagStore({
    knowledgeDir: KNOWLEDGE_DIR,
    storePath: VECTOR_STORE,
    ollamaUrl: OLLAMA_URL,
    embedModel: OLLAMA_EMBED_MODEL
});

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "100kb" }));

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

/** Keep only the base name and safe characters, so a name can never escape the folder. */
function sanitizeFileName(name) {
    const base = path.basename(String(name || "")).replace(/[^\w.\- ]/g, "_").trim();
    return base.slice(0, 100) || "upload.txt";
}

const storage = multer.diskStorage({
    // Absolute path, so the server works no matter which folder it is started from.
    destination: (req, file, cb) => cb(null, KNOWLEDGE_DIR),
    filename: (req, file, cb) => cb(null, sanitizeFileName(file.originalname))
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_PDF_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            const err = new Error(
                `Unsupported file type "${ext || "none"}". Upload a text or source-code file.`
            );
            err.status = 400;
            return cb(err);
        }
        cb(null, true);
    }
});

app.post("/upload", upload.single("file"), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file received. Send it in the form field named 'file'." });
        }
        const isPdf = path.extname(req.file.filename).toLowerCase() === ".pdf";
        if (!isPdf && req.file.size > MAX_UPLOAD_BYTES) {
            fs.unlinkSync(req.file.path);
            return res.status(413).json({ error: `File is too large (maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` });
        }

        // Index the document for semantic search. If that fails (for example the embedding
        // model is not pulled) the file is still saved and keyword search keeps working.
        let indexed = false, chunks = 0, indexError;
        try {
            const result = await rag.indexFile(req.file.filename);
            indexed = true;
            chunks = result.chunks;
            if (result.chunks === 0) {
                indexed = false;
                indexError = isPdf
                    ? "No text could be extracted from this PDF (it may be a scanned image)."
                    : "The file is empty, so there is nothing to search.";
            }
        } catch (err) {
            // Drop embeddings of an earlier upload with the same name; they no longer match the file.
            rag.removeFile(req.file.filename);
            indexError = err.message;
            console.error(`Indexing ${req.file.filename} failed: ${err.message}`);
        }

        // Return the stored name: it may differ from the original after sanitising.
        res.json({
            message: "File uploaded successfully",
            fileName: req.file.filename,
            size: req.file.size,
            indexed,
            chunks,
            ...(indexError ? { indexError } : {})
        });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Retrieval: keyword scoring over chunks
// ---------------------------------------------------------------------------

/** Lower-case words of 3+ characters, without common filler words. */
function keywords(text) {
    const words = String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))];
}

/**
 * Split every knowledge file into chunks, score each chunk by how many of the
 * question's keywords it contains (an exact phrase match scores extra) and
 * return the best TOP_CHUNKS as one block of context text.
 */
function searchKnowledge(question) {
    const terms = keywords(question);
    const phrase = String(question).trim().toLowerCase();
    const scored = [];

    for (const file of fs.readdirSync(KNOWLEDGE_DIR)) {
        if (file.startsWith(".")) continue; // skips .gitkeep and the vector store
        let data;
        try {
            if (path.extname(file).toLowerCase() === ".pdf") {
                const entry = rag.files[file];
                if (!entry) continue;
                data = entry.chunks.map((c) => c.text).join("\n");
            } else {
                data = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
            }
        } catch (err) {
            console.error(`Could not read ${file}: ${err.message}`);
            continue;
        }
        for (let i = 0; i < data.length; i += CHUNK_SIZE) {
            const chunk = data.substring(i, i + CHUNK_SIZE);
            const lower = chunk.toLowerCase();
            let score = terms.filter((t) => lower.includes(t)).length;
            if (phrase.length > 2 && lower.includes(phrase)) score += terms.length + 1;
            if (score > 0) scored.push({ file, chunk, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored.slice(0, TOP_CHUNKS);
    const context = best
        .map((c) => `==================================================\nFILE NAME: ${c.file}\n==================================================\n\n${c.chunk}\n`)
        .join("\n");
    return { context, sources: [...new Set(best.map((c) => c.file))] };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Question answering over the retrieved chunks. The answer must come only from the context:
 * the earlier 10-section format made the model pad short documents with outside knowledge,
 * and on a CPU it took several minutes per answer.
 */
function buildQuestionPrompt(context, question) {
    return `
You are an Embedded Systems AI Assistant that answers questions from the user's documents.

STRICT RULES:
1. Answer ONLY with facts stated in the DOCUMENT EXCERPTS below. Do not add outside knowledge, examples or code that are not in them.
2. If the excerpts do not contain the answer, reply exactly:
   "${NOT_AVAILABLE}"
3. If they answer only part of the question, answer that part and say what is missing.
4. Keep the answer short: a direct answer first, then a brief explanation (at most 150 words).
5. End with a line "Sources:" followed by the file names you used.

==================================================
DOCUMENT EXCERPTS
==================================================

${context}

==================================================
QUESTION
==================================================

${question}
`;
}

/** Small talk such as greetings or thanks: answered normally, without documents. */
function buildConversationPrompt(question) {
    return `
You are a friendly AI assistant for a document question-answering app.
Reply briefly and naturally to the message below. If it asks for facts, remind the user
that you answer questions from the documents they upload.

MESSAGE: ${question}
`;
}

const NOT_AVAILABLE = "Information not available in institutional database.";

const SMALL_TALK = /^\s*(hi|hello|hey|hii+|good (morning|afternoon|evening)|thanks|thank you|thx|ok(ay)?|bye|goodbye|how are you|who are you|what can you do)\b[\s!.?]*$/i;

/** Format retrieved chunks as numbered context blocks. */
function formatChunks(chunks) {
    return chunks
        .map((c, i) => `==================================================\n[${i + 1}] FILE NAME: ${c.file} (chunk ${c.chunk})\n==================================================\n\n${c.text}\n`)
        .join("\n");
}

/**
 * Find context for a question. Semantic (vector) search is tried first; keyword search is
 * the fallback when no embeddings exist or the embedding model cannot be reached.
 */
async function retrieve(question) {
    if (rag.chunkCount > 0) {
        try {
            const hits = await rag.search(question, RAG_TOP_K, RAG_MIN_SCORE);
            return {
                mode: "semantic",
                context: formatChunks(hits),
                sources: [...new Set(hits.map((h) => h.file))],
                references: hits.map((h) => ({
                    file: h.file,
                    chunk: h.chunk,
                    score: Math.round(h.score * 1000) / 1000,
                    preview: h.text.slice(0, 200)
                }))
            };
        } catch (err) {
            console.error(`Semantic search unavailable, using keyword search: ${err.message}`);
        }
    }
    const found = searchKnowledge(question);
    return { mode: "keyword", context: found.context, sources: found.sources, references: [] };
}

/** Explaining one uploaded file. */
function buildExplainPrompt(fileName, code, extraContext, question) {
    return `
You are a patient senior engineer explaining source code to a student.

Explain the file below using ONLY its contents. Do not invent functions that are not in the code.
Structure the answer as:

1. Purpose: what the file does, in two or three sentences
2. Walkthrough: go through the code in order, explaining each important block
3. Key functions and data: what they do and how they connect
4. Possible issues or improvements

==================================================
FILE NAME: ${fileName}
==================================================

${code}

${extraContext ? `==================================================\nRELATED REFERENCE MATERIAL\n==================================================\n\n${extraContext}\n` : ""}
==================================================
REQUEST
==================================================

${question}
`;
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

/** Send a prompt to Ollama and turn connection problems into readable errors. */
async function askOllama(prompt) {
    try {
        const response = await axios.post(
            `${OLLAMA_URL}/api/generate`,
            { model: OLLAMA_MODEL, prompt, stream: false },
            { timeout: OLLAMA_TIMEOUT_MS }
        );
        return response.data.response;
    } catch (err) {
        const e = new Error();
        if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
            e.status = 503;
            e.message = `Could not reach Ollama at ${OLLAMA_URL}. Is it running?`;
        } else if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
            e.status = 504;
            e.message = "The model took too long to answer. Try a smaller file or a shorter question.";
        } else if (err.response && err.response.status === 404) {
            e.status = 502;
            e.message = `Model "${OLLAMA_MODEL}" is not available. Run: ollama pull ${OLLAMA_MODEL}`;
        } else {
            e.status = 502;
            e.message = "The AI model returned an error.";
            console.error("Ollama error:", err.message);
        }
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

app.post("/chat", async (req, res, next) => {
    try {
        const { question, fileName } = req.body || {};

        if (typeof question !== "string" || !question.trim()) {
            return res.status(400).json({ error: "A non-empty 'question' is required." });
        }
        if (question.length > MAX_QUESTION_LENGTH) {
            return res.status(400).json({ error: `Question is too long (maximum ${MAX_QUESTION_LENGTH} characters).` });
        }

        const hasFile = fileName !== undefined && fileName !== null && fileName !== "";

        // Greetings and thanks get a normal conversational reply.
        if (!hasFile && SMALL_TALK.test(question)) {
            const answer = await askOllama(buildConversationPrompt(question));
            return res.json({ answer, sources: [], references: [], truncated: false, found: true, retrieval: "conversation" });
        }

        const found = await retrieve(question);
        let prompt;
        let truncated = false;
        const sources = [...found.sources];

        if (hasFile) {
            // Explain one specific uploaded file.
            if (typeof fileName !== "string") {
                return res.status(400).json({ error: "'fileName' must be a string." });
            }
            const safeName = sanitizeFileName(fileName);
            const filePath = path.join(KNOWLEDGE_DIR, safeName);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: `Uploaded file "${safeName}" was not found. Upload it again.` });
            }
            const full = await extractText(filePath);
            truncated = full.length > MAX_FILE_CONTEXT;
            prompt = buildExplainPrompt(safeName, full.substring(0, MAX_FILE_CONTEXT), found.context, question);
            if (!sources.includes(safeName)) sources.unshift(safeName);
        } else if (!found.context) {
            // Nothing relevant was retrieved. Answer directly instead of asking the model,
            // so it cannot make up an answer that looks document-based.
            return res.json({
                answer: NOT_AVAILABLE,
                sources: [],
                references: [],
                truncated: false,
                found: false,
                retrieval: found.mode
            });
        } else {
            // Question answering over the retrieved document chunks.
            prompt = buildQuestionPrompt(found.context, question);
        }

        console.log(`QUESTION (${found.mode}): ${question.slice(0, 120)}`);
        const answer = await askOllama(prompt);
        res.json({
            answer,
            sources,
            references: found.references,
            truncated,
            found: hasFile || Boolean(found.context),
            retrieval: found.mode
        });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Files and health
// ---------------------------------------------------------------------------

app.get("/files", (req, res) => {
    const files = fs.readdirSync(KNOWLEDGE_DIR)
        .filter((f) => !f.startsWith("."))
        .map((name) => ({
            name,
            size: fs.statSync(path.join(KNOWLEDGE_DIR, name)).size,
            indexed: Boolean(rag.files[name]),  // false: embeddings could not be created yet
            chunks: rag.chunksFor(name)         // 0 with indexed true: the file has no text
        }));
    res.json({ files });
});

app.post("/reindex", async (req, res, next) => {
    try {
        const result = await rag.sync();
        res.json({ ...result, totalChunks: rag.chunkCount });
    } catch (err) {
        next(err);
    }
});

app.get("/health", async (req, res) => {
    let ollama = "unreachable";
    try {
        await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 1500 });
        ollama = "reachable";
    } catch (err) { /* reported as unreachable */ }
    res.json({ status: "ok", model: OLLAMA_MODEL, embedModel: OLLAMA_EMBED_MODEL, ollama, indexedChunks: rag.chunkCount });
});

// ---------------------------------------------------------------------------
// Error handling: always answer with JSON and a meaningful status code
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
            ? `File is too large (maximum ${MAX_PDF_BYTES / 1024 / 1024} MB for PDFs).`
            : err.message;
        return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: message });
    }
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Request body is not valid JSON." });
    }
    const status = err.status || 500;
    if (status >= 500 && status !== 503 && status !== 504 && status !== 502) console.error(err);
    res.status(status).json({ error: err.message || "Internal server error" });
});

// Start listening only when run directly, so tests can import the app.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (model: ${OLLAMA_MODEL}, embeddings: ${OLLAMA_EMBED_MODEL})`);
        // Index files that were copied into the knowledge folder while the server was stopped.
        rag.sync()
            .then((r) => {
                if (r.indexed.length) console.log(`Indexed ${r.indexed.length} file(s) for semantic search.`);
                r.errors.forEach((e) => console.error(`Could not index ${e.fileName}: ${e.error}`));
            })
            .catch((err) => console.error(`Indexing on startup failed: ${err.message}`));
    });
}

module.exports = { app, rag, searchKnowledge, sanitizeFileName, keywords, buildQuestionPrompt };
