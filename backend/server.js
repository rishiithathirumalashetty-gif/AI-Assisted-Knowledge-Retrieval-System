/**
 * AI-Assisted Knowledge Retrieval System - backend
 * ------------------------------------------------
 * A small Express API that sits between the Angular frontend and a locally
 * running Ollama model.
 *
 *   POST /upload  save a text/code file into the knowledge folder
 *   POST /chat    answer a question (optionally explaining one uploaded file)
 *   GET  /files   list the files in the knowledge folder
 *   GET  /health  report whether the server and Ollama are reachable
 *
 * Retrieval is plain keyword matching over 5,000-character chunks. It is not
 * semantic search. Everything runs locally, so no document leaves the machine.
 *
 * Configuration (all optional) is read from environment variables, see
 * .env.example: PORT, OLLAMA_URL, OLLAMA_MODEL, CORS_ORIGIN, KNOWLEDGE_DIR.
 */
"use strict";

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:4200";
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, "knowledge");

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB per file
const CHUNK_SIZE = 5000;                  // characters per searchable chunk
const TOP_CHUNKS = 3;                     // best-matching chunks sent to the model
const MAX_FILE_CONTEXT = 12000;           // characters of an uploaded file sent to the model
const MAX_QUESTION_LENGTH = 2000;
const OLLAMA_TIMEOUT_MS = 120000;

// Only plain-text source and document files are accepted.
const ALLOWED_EXTENSIONS = new Set([
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".java", ".js", ".ts", ".py", ".go", ".rs",
    ".html", ".css", ".json", ".xml", ".yml", ".yaml", ".sql", ".sh", ".s", ".asm", ".ino",
    ".md", ".txt"
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
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
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

app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file received. Send it in the form field named 'file'." });
    }
    // Return the stored name: it may differ from the original after sanitising.
    res.json({
        message: "File uploaded successfully",
        fileName: req.file.filename,
        size: req.file.size
    });
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
        if (file.startsWith(".")) continue; // skips .gitkeep
        let data;
        try {
            data = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
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

/** Question answering over the knowledge folder (the original embedded-systems prompt). */
function buildQuestionPrompt(context, question) {
    return `
You are an Advanced Embedded Systems AI Assistant.

STRICT RULES:
1. ONLY answer from institutional knowledge.
2. NEVER use internet knowledge.
3. If unavailable say:
   "Information not available in institutional database."

For EVERY answer provide:

1. Definition
2. Detailed Explanation
3. Why it is used
4. Importance
5. Working Principle
6. Code Explanation
7. Suggestions
8. Viva Questions
9. Real-time Applications
10. Step-by-step Flow

==================================================
INSTITUTIONAL KNOWLEDGE
==================================================

${context}

==================================================
USER QUESTION
==================================================

${question}
`;
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

        const found = searchKnowledge(question);
        let prompt;
        let truncated = false;
        const sources = [...found.sources];

        if (fileName !== undefined && fileName !== null && fileName !== "") {
            // Explain one specific uploaded file.
            if (typeof fileName !== "string") {
                return res.status(400).json({ error: "'fileName' must be a string." });
            }
            const safeName = sanitizeFileName(fileName);
            const filePath = path.join(KNOWLEDGE_DIR, safeName);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: `Uploaded file "${safeName}" was not found. Upload it again.` });
            }
            const full = fs.readFileSync(filePath, "utf8");
            truncated = full.length > MAX_FILE_CONTEXT;
            prompt = buildExplainPrompt(safeName, full.substring(0, MAX_FILE_CONTEXT), found.context, question);
            if (!sources.includes(safeName)) sources.unshift(safeName);
        } else {
            // Question answering over the knowledge folder.
            const context = found.context || "Information not available in institutional database.";
            prompt = buildQuestionPrompt(context, question);
        }

        console.log(`QUESTION: ${question.slice(0, 120)}`);
        const answer = await askOllama(prompt);
        res.json({ answer, sources, truncated });
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
        .map((name) => ({ name, size: fs.statSync(path.join(KNOWLEDGE_DIR, name)).size }));
    res.json({ files });
});

app.get("/health", async (req, res) => {
    let ollama = "unreachable";
    try {
        await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 1500 });
        ollama = "reachable";
    } catch (err) { /* reported as unreachable */ }
    res.json({ status: "ok", model: OLLAMA_MODEL, ollama });
});

// ---------------------------------------------------------------------------
// Error handling: always answer with JSON and a meaningful status code
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
            ? `File is too large (maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`
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
    app.listen(PORT, () => console.log(`Server running on port ${PORT} (model: ${OLLAMA_MODEL})`));
}

module.exports = { app, searchKnowledge, sanitizeFileName, keywords };
