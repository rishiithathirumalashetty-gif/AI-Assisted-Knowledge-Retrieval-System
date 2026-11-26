// Starts the server in a child process with missing or invalid configuration and checks
// that it falls back to defaults and reports an unreachable Ollama instead of crashing.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("server starts with invalid settings and Ollama unreachable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
    const port = 39000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
        env: {
            ...process.env,
            PORT: String(port),
            KNOWLEDGE_DIR: path.join(dir, "kb"),  // does not exist yet: must be created
            OLLAMA_URL: "http://127.0.0.1:9",     // nothing listens here
            RAG_TOP_K: "not-a-number",
            RAG_MIN_SCORE: ""
        },
        stdio: "ignore"
    });
    try {
        let health;
        for (let i = 0; i < 50 && !health; i++) {
            await new Promise((r) => setTimeout(r, 100));
            health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => undefined);
        }
        assert.ok(health, "server answered /health");
        assert.strictEqual(health.status, "ok");
        assert.strictEqual(health.ollama, "unreachable");
        assert.strictEqual(health.model, "qwen2.5-coder:7b");
        assert.ok(fs.existsSync(path.join(dir, "kb")), "knowledge folder was created");

        const res = await fetch(`http://127.0.0.1:${port}/chat`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "Hello" })
        });
        assert.strictEqual(res.status, 503);
        assert.match((await res.json()).error, /Could not reach Ollama/);
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
