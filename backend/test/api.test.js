// Backend tests using Node's built-in test runner (Node 18+): npm test
// A tiny fake Ollama server is used, so no real model is needed.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
process.env.KNOWLEDGE_DIR = tmp;

// Behaves like a grounded model: answers with the first sentence of the first excerpt.
// With fabricate=true it answers from "outside knowledge" instead.
let fabricate = false;
function fakeAnswer(prompt) {
    if (!String(prompt || "").includes("DOCUMENT EXCERPTS")) return "FAKE-ANSWER";
    if (fabricate) return "SPI uses a master and slave with a separate clock line and chip select.\n\nSources:\ncan-bus.pdf";
    const excerpt = prompt.split(/FILE NAME: [^\n]*\n=+\n\n/)[1] || "";
    const firstLine = excerpt.split("\n").find((l) => l.trim().length > 20) || excerpt;
    return `${firstLine.trim()}\n\nSources:\nmade-up-file.pdf`;
}
let lastPrompt = "";
const fakeOllama = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [] }));
        lastPrompt = JSON.parse(body).prompt;
        res.end(JSON.stringify({ response: fakeAnswer(lastPrompt) }));
    });
});

let server, base, ollamaPort;
test.before(async () => {
    await new Promise((r) => fakeOllama.listen(0, "127.0.0.1", r));
    ollamaPort = fakeOllama.address().port;
    process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`;
    const { app } = require("../server");
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeOllama.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (url, json) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
const upload = (name, content) => {
    const f = new FormData();
    f.append("file", new Blob([content]), name);
    return fetch(base + "/upload", { method: "POST", body: f });
};

test("health reports Ollama reachable", async () => {
    const body = await (await fetch(base + "/health")).json();
    assert.strictEqual(body.status, "ok");
    assert.strictEqual(body.ollama, "reachable");
});

test("upload stores a file and returns its name", async () => {
    const res = await upload("blink.c", "int main(void){ return 0; }");
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).fileName, "blink.c");
    assert.ok(fs.existsSync(path.join(tmp, "blink.c")));
});

test("upload rejects unsupported file types", async () => {
    const res = await upload("virus.exe", "x");
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /Unsupported file type/);
});

test("upload rejects files over 2 MB", async () => {
    const res = await upload("big.txt", "a".repeat(2 * 1024 * 1024 + 10));
    assert.strictEqual(res.status, 413);
});

test("upload cannot escape the knowledge folder", async () => {
    await upload("..%2F..%2Fevil.txt", "x");
    assert.ok(!fs.existsSync(path.join(tmp, "..", "evil.txt")));
});

test("chat validates the question", async () => {
    assert.strictEqual((await post("/chat", {})).status, 400);
    assert.strictEqual((await post("/chat", { question: "   " })).status, 400);
    assert.strictEqual((await post("/chat", { question: "x".repeat(2001) })).status, 400);
});

test("chat explains an uploaded file and includes its code in the prompt", async () => {
    const res = await post("/chat", { question: "Explain this code", fileName: "blink.c" });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.answer, "FAKE-ANSWER");
    assert.ok(lastPrompt.includes("int main(void)"));
});

test("chat returns 404 for an unknown uploaded file", async () => {
    const res = await post("/chat", { question: "Explain", fileName: "missing.c" });
    assert.strictEqual(res.status, 404);
});

test("keyword search finds the right document", async () => {
    await upload("uart.txt", "The UART peripheral sends serial data one bit at a time.");
    await upload("adc.txt", "The ADC converts an analog voltage into a digital number.");
    const res = await post("/chat", { question: "How does the UART send serial data?" });
    const body = await res.json();
    assert.deepStrictEqual(body.sources, ["uart.txt"]);
    assert.ok(lastPrompt.includes("UART peripheral"));
    assert.ok(!lastPrompt.includes("analog voltage"));
});

test("unanswerable question says the information is missing without asking the model", async () => {
    lastPrompt = "";
    const body = await (await post("/chat", { question: "quantum gravity zebra" })).json();
    assert.strictEqual(body.answer, "Information not available in the uploaded documents.");
    assert.strictEqual(body.found, false);
    assert.strictEqual(lastPrompt, "", "the model is not called when nothing was retrieved");
});

test("chat reports 503 when Ollama is down", async () => {
    fakeOllama.close();
    const res = await post("/chat", { question: "UART serial data" });
    assert.strictEqual(res.status, 503);
    assert.match((await res.json()).error, /Could not reach Ollama/);
});
