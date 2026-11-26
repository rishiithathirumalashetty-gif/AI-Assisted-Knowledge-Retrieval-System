// End-to-end check against a running backend and a real Ollama.
// Start the backend first (npm start), then run: npm run smoke
// Uploads two sample documents, asks questions and prints PASS/FAIL for each step.
"use strict";

const fs = require("fs");
const path = require("path");

const API = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
const results = [];

function report(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

async function post(url, body) {
    const res = await fetch(API + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
}

async function upload(name, content) {
    const form = new FormData();
    form.append("file", new Blob([content]), name);
    const res = await fetch(API + "/upload", { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
}

async function main() {
    console.log(`Backend: ${API}\n`);

    let health;
    try {
        health = await (await fetch(API + "/health")).json();
    } catch (err) {
        report("Backend reachable", false, `Start it with "npm start" in backend/ (${err.message})`);
        return;
    }
    report("Backend reachable", true);
    report("Ollama reachable", health.ollama === "reachable", health.ollama !== "reachable" ? "Start Ollama (ollama serve)" : "");
    if (health.ollama !== "reachable") return;

    const pdf = await upload("smoke-can-bus.pdf", fs.readFileSync(path.join(__dirname, "..", "test", "fixtures", "can-bus.pdf")));
    report("PDF upload and embedding", pdf.status === 200 && pdf.body.indexed,
        pdf.body.indexed ? `${pdf.body.chunks} chunk(s)` : pdf.body.indexError || pdf.body.error);

    const txt = await upload("smoke-gpio.txt",
        "To configure a GPIO pin as output, set Mode to GPIO_MODE_OUTPUT_PP in GPIO_InitTypeDef and call HAL_GPIO_Init.");
    report("TXT upload and embedding", txt.status === 200 && txt.body.indexed,
        txt.body.indexed ? `${txt.body.chunks} chunk(s)` : txt.body.indexError || txt.body.error);

    console.log("\nAsking the model (this can take a while on a CPU)...\n");

    const inDocs = await post("/chat", { question: "Which identifier wins CAN bus arbitration?" });
    const top = inDocs.body.references && inDocs.body.references[0];
    report("Question answered from documents", inDocs.status === 200 && inDocs.body.retrieval === "semantic" && top && top.file === "smoke-can-bus.pdf",
        inDocs.status === 200 ? `retrieval=${inDocs.body.retrieval}, top source=${top ? `${top.file} (${top.score})` : "none"}` : inDocs.body.error);
    if (inDocs.status === 200) {
        const mentions = /lowest/i.test(inDocs.body.answer);
        report("Answer uses the retrieved text (mentions 'lowest identifier')", mentions);
        console.log(`\n----- model answer -----\n${inDocs.body.answer.trim()}\n------------------------\n`);
    }

    const notInDocs = await post("/chat", { question: "What is the boiling point of mercury?" });
    report("Unrelated question is refused without calling the model", notInDocs.body.found === false,
        `answer: ${String(notInDocs.body.answer || notInDocs.body.error).slice(0, 80)}`);

    // Same subject area but not covered by the documents: retrieval may find loosely related
    // chunks, so the model itself has to say the information is not available.
    const nearTopic = await post("/chat", { question: "How does the I2C protocol address devices?" });
    const declined = nearTopic.status === 200 && (nearTopic.body.found === false || /not available/i.test(nearTopic.body.answer));
    report("Related but uncovered question is declined", declined,
        nearTopic.status === 200 ? `retrieval=${nearTopic.body.retrieval}, found=${nearTopic.body.found}: ${nearTopic.body.answer.trim().slice(0, 100)}` : nearTopic.body.error);

    // Clean up the sample documents so they do not stay in your knowledge base.
    for (const f of ["smoke-can-bus.pdf", "smoke-gpio.txt"]) {
        fs.rmSync(path.join(process.env.KNOWLEDGE_DIR || path.join(__dirname, "..", "knowledge"), f), { force: true });
    }
    await post("/reindex", {});

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
