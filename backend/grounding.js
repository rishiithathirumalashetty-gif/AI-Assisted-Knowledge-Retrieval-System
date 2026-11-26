/**
 * Answer verification: keep only sentences of a model answer that are supported by the
 * retrieved document text. A local model can ignore "answer only from the context" and
 * fill gaps with its own knowledge, so this check runs on every answer.
 *
 * A sentence is kept when
 *   - every number and code identifier in it appears in the retrieved text, and
 *   - either at least half of its content words appear in the retrieved text,
 *     or (for paraphrases) its embedding is very close to a sentence of the retrieved text.
 *
 * The semantic cut-off of 0.75 was measured with nomic-embed-text: correct paraphrases scored
 * 0.49-0.83, while same-topic fabrications that pass the number/identifier rule scored up to
 * 0.65. A lower cut-off would accept fabrications, so some paraphrases are still dropped.
 */
"use strict";

const STOP_WORDS = new Set([
    "this", "that", "with", "from", "they", "will", "would", "there", "their", "which", "about",
    "into", "than", "then", "them", "these", "those", "your", "have", "been", "were", "what",
    "when", "where", "while", "also", "each", "such", "only", "some", "more", "most", "other",
    "same", "very", "just", "here", "make", "made", "does", "done", "using", "used", "uses",
    "follow", "following", "steps", "step", "first", "then", "finally", "next", "need", "needs",
    "should", "could", "must", "answer", "question", "document", "documents", "excerpt",
    "excerpts", "information", "available", "explain", "explanation", "based", "provided",
    "mentioned", "stated", "according", "however", "therefore", "thus", "example"
]);

/** Lower-case, strip a few English suffixes so "transmits" matches "transmit". */
function stem(word) {
    return word
        .replace(/(ization|ations|ation|ingly|ing|edly|ed|ies|es|s|ly)$/, "")
        .slice(0, 12);
}

function contentWords(text) {
    const words = String(text).toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || [];
    return words.filter((w) => !STOP_WORDS.has(w)).map(stem);
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Numbers (except list markers) and identifiers with "_", "(" or mixed letters and digits. */
function exactTokens(sentence) {
    const text = String(sentence).replace(/^\s*\d+[.)]\s+/, "").toLowerCase();
    const numbers = text.match(/\b\d+(?:\.\d+)?\b/g) || [];
    const identifiers = (text.match(/[a-z_][a-z0-9_]*(?=\()|\b[a-z0-9]*_[a-z0-9_]+\b/g) || []);
    return [...new Set([...numbers, ...identifiers])];
}

/** Split into sentences and list items, keeping code-like lines together. */
function splitSentences(text) {
    return String(text)
        // Split on new lines and on sentence ends, but not after list numbers like "1."
        .split(/\n+|(?<=[a-z)`'"]{2}[.!?])\s+(?=[A-Z`*])/)
        .map((s) => s.replace(/\s+$/, ""))
        .filter((s) => s.trim());
}

/** A trailing "Sources:" block written by the model; real sources come from retrieval. */
function stripModelSources(answer) {
    const idx = String(answer).search(/\n\s*\**\s*sources?\s*:?\**\s*(\n|$)/i);
    return idx >= 0 ? answer.slice(0, idx).trim() : String(answer).trim();
}

/**
 * @param {string} answer  model output
 * @param {string} context the retrieved chunk text given to the model
 * @param {number} minSupport fraction of a sentence's content words that must occur in the context
 * @returns {{ text: string, supported: boolean, removed: number, kept: number }}
 */
async function verifyAnswer(answer, context, { minSupport = 0.5, embed = null, minSimilarity = 0.75 } = {}) {
    const evidence = new Set(contentWords(context));
    const evidenceText = String(context).toLowerCase();
    let kept = [];
    let removed = 0;
    const candidates = [];

    for (const sentence of splitSentences(stripModelSources(answer))) {
        const words = contentWords(sentence);
        if (words.length === 0) {
            // Headings, list markers or very short lines: keep only if something else is kept.
            kept.push({ sentence, neutral: true });
            continue;
        }
        const support = words.filter((w) => evidence.has(w)).length / words.length;
        // Numbers and code identifiers are where invented facts usually show up
        // ("25 mA", "1 Mbit/s", a made-up function name), so each must appear verbatim.
        const exactOk = exactTokens(sentence).every((t) => evidenceText.includes(t));
        if (!exactOk) { removed++; continue; }
        if (support >= minSupport) { kept.push({ sentence, neutral: false }); continue; }
        candidates.push({ index: kept.length, sentence });
        kept.push(null); // placeholder, decided by the semantic check below
    }

    if (candidates.length && embed) {
        const evidenceSentences = splitSentences(context).filter((x) => x.trim().length > 15);
        try {
            const vectors = await embed([...candidates.map((c) => c.sentence), ...evidenceSentences]);
            const evidenceVectors = vectors.slice(candidates.length);
            candidates.forEach((c, i) => {
                const best = Math.max(0, ...evidenceVectors.map((v) => cosine(vectors[i], v)));
                kept[c.index] = best >= minSimilarity ? { sentence: c.sentence, neutral: false } : null;
            });
        } catch (err) {
            // Without embeddings, unsupported-looking sentences stay removed (the safe choice).
        }
    }
    removed += kept.filter((k) => k === null).length;
    kept = kept.filter(Boolean);

    const supported = kept.some((k) => !k.neutral);
    return {
        text: supported ? kept.map((k) => k.sentence).join("\n").trim() : "",
        supported,
        removed,
        kept: kept.filter((k) => !k.neutral).length
    };
}

/**
 * Keep only the retrieved chunks whose words the final answer actually uses, so a chunk that
 * was retrieved but not used (for example from another document) is not shown as a source.
 */
function citedChunks(answer, chunks, minShare = 0.3) {
    const words = [...new Set(contentWords(answer))];
    if (!words.length) return [];
    const scored = chunks.map((c) => {
        const evidence = new Set(contentWords(c.text));
        return { chunk: c, share: words.filter((w) => evidence.has(w)).length / words.length };
    });
    const best = Math.max(...scored.map((s) => s.share));
    return scored.filter((s) => s.share >= minShare || s.share === best).map((s) => s.chunk);
}

module.exports = { verifyAnswer, citedChunks, exactTokens, stripModelSources, contentWords, splitSentences };
