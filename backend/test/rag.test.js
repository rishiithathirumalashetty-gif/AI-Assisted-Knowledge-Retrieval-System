// RAG pipeline tests (Node's built-in test runner): npm test
// A fake Ollama server implements /api/embed and /api/generate. Its embeddings are
// deterministic bag-of-words vectors, so texts that share words are similar, which is
// enough to test chunking, indexing, vector search, prompts and source references
// without downloading a real model.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { chunkText, cosineSimilarity, extractText } = require("../rag");

const DIM = 256;
const STOP = new Set(["the", "a", "an", "is", "of", "on", "in", "to", "and", "how", "does", "what", "do", "which", "with", "into"]);
function fakeEmbedding(text) {
    const v = new Array(DIM).fill(0);
    for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
        if (STOP.has(w)) continue;
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % DIM] += 1;
    }
    return v;
}

let lastPrompt = "";
let embedCalls = 0;
let embedBroken = false;
const fakeOllama = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [] }));
        const json = JSON.parse(body);
        if (req.url === "/api/embed") {
            embedCalls++;
            if (embedBroken) { res.statusCode = 404; return res.end(JSON.stringify({ error: "model not found" })); }
            return res.end(JSON.stringify({ embeddings: json.input.map(fakeEmbedding) }));
        }
        lastPrompt = json.prompt;
        res.end(JSON.stringify({ response: "FAKE-ANSWER" }));
    });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-"));
let server, base, rag;

test.before(async () => {
    await new Promise((r) => fakeOllama.listen(0, "127.0.0.1", r));
    process.env.KNOWLEDGE_DIR = tmp;
    process.env.OLLAMA_URL = `http://127.0.0.1:${fakeOllama.address().port}`;
    delete require.cache[require.resolve("../server")];
    const mod = require("../server");
    rag = mod.rag;
    await new Promise((r) => { server = mod.app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeOllama.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (url, json) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
const upload = (name, content) => {
    const f = new FormData();
    f.append("file", new Blob([content]), name);
    return fetch(base + "/upload", { method: "POST", body: f });
};

// --- unit tests -------------------------------------------------------------

test("chunkText splits long text into overlapping chunks without cutting words", () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`);
    const chunks = chunkText(words.join(" "), 1000, 200);
    assert.ok(chunks.length > 1);
    chunks.forEach((c) => assert.ok(c.length <= 1000));
    // neighbouring chunks share text (the overlap)
    const tail = chunks[0].split(" ").slice(-5).join(" ");
    assert.ok(chunks[1].includes(tail), "second chunk should start with the end of the first");
    // no word is cut in half
    for (const c of chunks) for (const w of c.split(" ")) assert.match(w, /^word\d+$/);
});

test("chunkText handles short and empty text", () => {
    assert.deepStrictEqual(chunkText("short text"), ["short text"]);
    assert.deepStrictEqual(chunkText("   "), []);
    assert.throws(() => chunkText("x", 100, 100));
});

test("cosineSimilarity is 1 for identical and 0 for unrelated vectors", () => {
    assert.strictEqual(cosineSimilarity([1, 2, 3], [1, 2, 3]).toFixed(6), "1.000000");
    assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("extractText reads text from a PDF", async () => {
    const text = await extractText(path.join(__dirname, "fixtures", "can-bus.pdf"));
    assert.match(text, /lowest identifier wins/);
    assert.ok(!/-- 1 of 1 --/.test(text));
});

// --- API tests ----------------------------------------------------------------

test("uploading a TXT file extracts, chunks and embeds it", async () => {
    const before = embedCalls;
    const res = await upload("uart.txt", "The UART peripheral sends serial data one bit at a time using a baud rate.");
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.indexed, true);
    assert.strictEqual(body.chunks, 1);
    assert.ok(embedCalls > before, "embedding endpoint was called");
    assert.strictEqual(rag.chunksFor("uart.txt"), 1);
    assert.strictEqual(rag.files["uart.txt"].chunks[0].embedding.length, DIM);
});

test("uploading a PDF extracts its text and indexes it", async () => {
    const res = await upload("can-bus.pdf", fs.readFileSync(path.join(__dirname, "fixtures", "can-bus.pdf")));
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.indexed, true);
    assert.ok(body.chunks >= 1);
    assert.ok(!body.indexError);
    assert.match(rag.files["can-bus.pdf"].chunks[0].text, /CAN frame/);
});

test("text files over 2 MB are still rejected now that PDFs may be larger", async () => {
    const res = await upload("big.txt", "a".repeat(2 * 1024 * 1024 + 10));
    assert.strictEqual(res.status, 413);
    assert.ok(!fs.existsSync(path.join(tmp, "big.txt")));
});

test("the vector store is saved to disk and listed with chunk counts", async () => {
    const store = JSON.parse(fs.readFileSync(path.join(tmp, ".vector-store.json"), "utf8"));
    assert.ok(store.files["uart.txt"] && store.files["can-bus.pdf"]);
    const files = (await (await fetch(base + "/files")).json()).files;
    assert.ok(files.find((f) => f.name === "can-bus.pdf").chunks >= 1);
    assert.ok(!files.find((f) => f.name.startsWith(".")), "vector store is not listed as a document");
});

test("semantic search retrieves the relevant PDF chunk and cites it", async () => {
    await upload("adc.txt", "The ADC converts an analog voltage into a digital number.");
    const res = await post("/chat", { question: "Which identifier wins CAN bus arbitration?" });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.retrieval, "semantic");
    assert.strictEqual(body.found, true);
    assert.strictEqual(body.sources[0], "can-bus.pdf");
    assert.strictEqual(body.references[0].file, "can-bus.pdf");
    assert.ok(body.references[0].score > 0.3);
    assert.ok(lastPrompt.includes("lowest identifier wins"), "retrieved chunk is in the prompt");
    assert.ok(lastPrompt.includes("[1] FILE NAME: can-bus.pdf"));
    assert.ok(!lastPrompt.includes("analog voltage"), "unrelated document is not in the prompt");
});

test("a question with no relevant document is answered without calling the model", async () => {
    lastPrompt = "";
    const res = await post("/chat", { question: "quantum gravity zebra" });
    const body = await res.json();
    assert.strictEqual(body.retrieval, "semantic");
    assert.strictEqual(body.found, false);
    assert.deepStrictEqual(body.sources, []);
    assert.strictEqual(body.answer, "Information not available in institutional database.");
    assert.strictEqual(lastPrompt, "", "no generation request was sent");
});

test("an empty document is stored but reported as not indexed", async () => {
    const body = await (await upload("empty.txt", "")).json();
    assert.strictEqual(body.indexed, false);
    assert.strictEqual(body.chunks, 0);
    assert.match(body.indexError, /empty/);
});

test("greetings get a normal conversational reply without documents", async () => {
    const res = await post("/chat", { question: "Hello!" });
    const body = await res.json();
    assert.strictEqual(body.retrieval, "conversation");
    assert.deepStrictEqual(body.sources, []);
    assert.ok(lastPrompt.includes("friendly AI assistant"));
});

test("explaining an uploaded PDF uses its extracted text", async () => {
    await post("/chat", { question: "Explain this document", fileName: "can-bus.pdf" });
    assert.ok(lastPrompt.includes("vehicle network"));
    assert.ok(!lastPrompt.includes("%PDF"));
});

test("falls back to keyword search when the embedding model is unavailable", async () => {
    embedBroken = true;
    try {
        const res = await post("/chat", { question: "How does the UART send serial data?" });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.retrieval, "keyword");
        assert.strictEqual(body.sources[0], "uart.txt", "best keyword match comes first");

        const up = await (await upload("spi.txt", "SPI uses a clock line and chip select.")).json();
        assert.strictEqual(up.indexed, false);
        assert.match(up.indexError, /ollama pull nomic-embed-text/);
    } finally {
        embedBroken = false;
    }
});

test("reindex embeds files that were added without indexing", async () => {
    const res = await post("/reindex", {});
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(body.indexed.some((f) => f.fileName === "spi.txt"));
    assert.strictEqual(rag.chunksFor("spi.txt"), 1);
    const health = await (await fetch(base + "/health")).json();
    assert.strictEqual(health.embedModel, "nomic-embed-text");
    assert.ok(health.indexedChunks >= 4);
});

test("a document whose text cannot be read does not crash the server", async () => {
    // A file with a .pdf name that is not a real PDF: extraction fails, upload still answers.
    const res = await upload("broken.pdf", "this is not a pdf");
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.indexed, false);
    assert.ok(body.indexError);
    const health = await fetch(base + "/health");
    assert.strictEqual(health.status, 200);
});

test("re-uploading a file when embeddings fail removes its old embeddings", async () => {
    await upload("notes.txt", "The watchdog timer resets the microcontroller.");
    assert.strictEqual(rag.chunksFor("notes.txt"), 1);
    embedBroken = true;
    try {
        const body = await (await upload("notes.txt", "Completely different content about DMA.")).json();
        assert.strictEqual(body.indexed, false);
        assert.ok(!rag.files["notes.txt"], "stale embeddings were dropped");
        const files = (await (await fetch(base + "/files")).json()).files;
        const entry = files.find((f) => f.name === "notes.txt");
        assert.strictEqual(entry.indexed, false);
    } finally {
        embedBroken = false;
    }
    const empty = (await (await fetch(base + "/files")).json()).files.find((f) => f.name === "empty.txt");
    assert.deepStrictEqual([empty.indexed, empty.chunks], [true, 0], "empty file counts as indexed with no text");
});
