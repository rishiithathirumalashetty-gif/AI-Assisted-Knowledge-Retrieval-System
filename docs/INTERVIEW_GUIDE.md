# Interview guide

Notes for explaining and demonstrating the project. Everything here describes code that is in this repository.

## One-minute summary

A local document assistant. You upload PDFs or text files, ask questions, and get answers built only from those files, with the source chunks and their similarity scores shown under each answer. It is an Angular frontend, a Node.js/Express backend and Ollama running two local models: `nomic-embed-text` for embeddings and `qwen2.5-coder:7b` for answers. Nothing leaves the machine and there are no API keys.

## Architecture

```
Angular (4200) ──REST/JSON──▶ Express (3000) ──HTTP──▶ Ollama (11434)
                                   │                    ├─ nomic-embed-text  (/api/embed)
                                   │                    └─ qwen2.5-coder:7b  (/api/generate)
                                   ▼
                       backend/knowledge/        uploaded files
                       .vector-store.json        chunk text + embedding vectors
```

| File | Responsibility |
| --- | --- |
| `backend/server.js` | Routes, validation, retrieval (semantic first, keyword fallback), prompts, error mapping |
| `backend/rag.js` | Text extraction, chunking, embedding calls, vector store, cosine search |
| `frontend/src/app/chat/` | Knowledge-base panel, questions, answers, source references |
| `frontend/src/app/uploads/` | "Explain a file" screen and shared file validation |
| `frontend/src/app/api.service.ts` | Typed client for the REST API |

## RAG pipeline, step by step

1. **Upload:** Multer saves the file. The type whitelist and size limits (2 MB text, 10 MB PDF) are checked on the client and again on the server, and the file name is sanitised so it cannot escape the folder.
2. **Extract:** `pdf-parse` for PDFs, UTF-8 for everything else.
3. **Chunk:** about 1,000 characters with a 200-character overlap. Ends move back to a space so words are not cut. The overlap keeps a sentence that crosses a boundary complete in at least one chunk.
4. **Embed:** chunks go to Ollama `/api/embed` in batches of 16, producing 768-dimensional vectors.
5. **Store:** vectors plus chunk text go into one JSON file, written atomically (write a temp file, then rename). File size and modification time are stored so unchanged files are not re-embedded.
6. **Retrieve:** the question is embedded the same way. Every chunk is scored by cosine similarity, and the top 4 above 0.5 are kept.
7. **Generate:** the chunks are numbered and labelled with file names in a prompt that says "answer only from these excerpts, otherwise say it is not available", then sent to `/api/generate`.
8. **Respond:** answer, source files, and references (file, chunk number, score, preview).

## Decisions and trade-offs

| Decision | Why | Trade-off |
| --- | --- | --- |
| JSON file as vector store | No extra service to install; easy to inspect; fast enough for hundreds of documents | Linear scan, whole store in memory; not for very large collections |
| Threshold 0.5 | Measured with real embeddings: answerable 0.62 to 0.84, unrelated 0.33 to 0.42 | Questions on the same subject that the documents don't cover can still pass (0.48 to 0.61), so the prompt must also refuse them |
| Answer without the model when nothing is retrieved | Instant, and the model cannot invent an answer | None |
| Keyword search fallback | The app still works if the embedding model is missing | Lower quality; the UI labels it as "Keyword search" |
| Short grounded prompt instead of a 10-section format | The long format made the model pad answers with outside knowledge, and took 348 s on a CPU | Answers are shorter |
| Local models only | Privacy: company code never leaves the machine | Slow without a GPU (about 2.5 tokens per second on the test laptop) |
| Overlapping fixed-size chunks | Simple and predictable | Not aware of headings or sections |

## Questions you may be asked

**Why RAG instead of fine-tuning?** Documents change. With RAG you upload a new file and it is searchable immediately, answers can cite their sources, and no training is needed.

**What does an embedding represent?** A vector where texts with similar meaning point in similar directions. Cosine similarity measures the angle between two vectors, so it ignores length.

**How do you stop hallucination?** In three layers. First, a similarity threshold drops irrelevant chunks. Second, if nothing is left, the server answers "not available" without calling the model. Third, the prompt forbids outside knowledge and requires a fixed refusal sentence. This was checked with the real model: an SPI question against CAN-only documents was refused.

**Why chunk with overlap?** Without overlap, a fact split across two chunks may not be fully present in either one.

**How would you scale it?** Move to a vector database or an approximate nearest-neighbour index (for example SQLite with a vector extension or pgvector), embed in a background job queue, stream answers, and run Ollama on a GPU server.

**What happens if Ollama is down?** `/health` reports it and the header badge turns amber. `/chat` returns 503 with a readable message, and uploads still save the file and offer to re-index later.

**How is it tested?** Thirty backend tests use a fake Ollama with deterministic embeddings (chunking, PDF extraction, retrieval, sources, fallback, empty and corrupted files, configuration). Frontend unit tests run in headless Chrome. `npm run smoke` checks the whole flow against the real models. Real-model results are recorded in the README.

**What would you improve next?** Streaming answers, chunking that follows headings, hybrid keyword and vector search with re-ranking, and deleting documents from the UI.

## Live demo (about 3 minutes)

1. Start Ollama, then the backend (`npm start` in `backend/`) and the frontend (`npm start` in `frontend/`). Open http://localhost:4200 and point out the green status badge.
2. **Ask the knowledge base → + Add documents:** select a PDF and a TXT file together. Show the chunk counts.
3. Ask a question answered in the PDF. Show the answer, the **Semantic search** label, and the source with its chunk number and match score.
4. Ask something on the same subject that is not in the files (for example "How does an SPI bus work?"). The answer is "Information not available".
5. Ask something unrelated. It is refused instantly, without calling the model.
6. Switch to **Explain a file** and explain a short source file.

Tip: on a laptop without a GPU, answers take 20 to 60 seconds. Ask one question before the interview so the model is already loaded into memory. Avoid switching to `qwen2.5-coder:1.5b` for speed: in testing it invented an answer and a citation for a question the documents did not cover.

**Why not a smaller model?** It was measured: 1.5B is about 6 times faster on the same CPU, but it fabricated an SPI explanation and cited the CAN document. 7B refused correctly. Grounding was more important than speed.
