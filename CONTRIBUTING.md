# Contributing

This project is maintained by two people. The workflow is kept simple.

## Workflow

1. Pull the latest `main`.
2. Create a branch for one change: `feature/<short-name>` or `fix/<short-name>`.
3. Make the change and run the checks below.
4. Push the branch and open a pull request to `main`. Say what changed and how you tested it.
5. The other person reviews the pull request. It is merged after approval. Nobody pushes directly to `main` or force-pushes a shared branch.

## Checks before opening a pull request

```bash
cd backend && npm test
cd ../frontend && npm test -- --watch=false --browsers=ChromeHeadlessCI && npm run build
```

If you changed how retrieval or prompts work, also try it by hand with Ollama running: upload a document, ask a question whose answer is in it, and ask one whose answer is not.

## Conventions

- Commit messages say what changed and why, in the imperative ("Add PDF upload to knowledge base").
- Keep the backend and frontend file-type and size limits in sync (`backend/server.js` and `frontend/src/app/uploads/upload.component.ts`).
- Add or update tests with each change in behaviour.
- Never commit `.env` files, documents from `backend/knowledge/`, or the vector store.
