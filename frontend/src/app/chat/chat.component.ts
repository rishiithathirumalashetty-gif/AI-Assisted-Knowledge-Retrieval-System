import { Component, OnInit } from '@angular/core';

import { ApiService, KnowledgeFile, SourceReference } from '../api.service';
import { AnswerSegment, errorMessage, splitAnswer } from '../answer-format';
import { validateFile } from '../uploads/upload.component';

const MAX_QUESTION = 2000;

/** Ask a question that is answered from the documents in the backend's knowledge folder (RAG). */
@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent implements OnInit {

  question = '';
  segments: AnswerSegment[] = [];
  sources: string[] = [];
  references: SourceReference[] = [];
  found = true;
  retrieval = '';
  loading = false;
  error = '';

  // Knowledge base
  files: KnowledgeFile[] = [];
  uploading = false;
  reindexing = false;
  docMessage = '';
  docError = '';

  readonly maxQuestion = MAX_QUESTION;
  readonly examples = ['What does the UART peripheral do?', 'How do I configure a GPIO pin as output?'];

  constructor(private apiService: ApiService) { }

  ngOnInit(): void {
    this.loadFiles();
  }

  get unindexedCount(): number {
    return this.files.filter((f) => f.chunks === 0).length;
  }

  loadFiles(): void {
    this.apiService.listFiles().subscribe(
      (res) => (this.files = res.files),
      () => (this.files = [])
    );
  }

  /** Upload one or more documents into the knowledge base. Each is chunked and embedded by the backend. */
  addDocuments(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files ? Array.from(input.files) : [];
    input.value = '';
    this.docError = '';
    this.docMessage = '';
    if (!chosen.length) { return; }

    const problems = chosen.map((f) => validateFile(f) && `${f.name}: ${validateFile(f)}`).filter(Boolean);
    if (problems.length) {
      this.docError = problems.join(' ');
      return;
    }

    this.uploading = true;
    const notes: string[] = [];
    const next = (i: number): void => {
      if (i >= chosen.length) {
        this.uploading = false;
        this.docMessage = notes.join(' ');
        this.loadFiles();
        return;
      }
      const form = new FormData();
      form.append('file', chosen[i]);
      this.apiService.uploadFile(form).subscribe(
        (res) => {
          notes.push(res.indexed
            ? `${res.fileName}: indexed (${res.chunks} chunk${res.chunks === 1 ? '' : 's'}).`
            : `${res.fileName}: saved, but not indexed for semantic search (${res.indexError}). Keyword search will be used.`);
          if (res.indexed && res.indexError) { notes.push(res.indexError); }
          next(i + 1);
        },
        (err) => {
          this.docError = `${chosen[i].name}: ${errorMessage(err, 'Upload failed.')}`;
          this.uploading = false;
          this.loadFiles();
        }
      );
    };
    next(0);
  }

  reindex(): void {
    this.reindexing = true;
    this.docError = '';
    this.docMessage = '';
    this.apiService.reindex().subscribe(
      (res) => {
        this.reindexing = false;
        this.docMessage = res.indexed.length ? `Indexed ${res.indexed.length} document(s).` : 'All documents are already indexed.';
        if (res.errors.length) { this.docError = res.errors.map((e) => `${e.fileName}: ${e.error}`).join(' '); }
        this.loadFiles();
      },
      (err) => {
        this.reindexing = false;
        this.docError = errorMessage(err, 'Re-indexing failed.');
      }
    );
  }

  ask(): void {
    const q = this.question.trim();
    if (!q) {
      this.error = 'Type a question first.';
      return;
    }
    if (q.length > MAX_QUESTION) {
      this.error = `Your question is too long (maximum ${MAX_QUESTION} characters).`;
      return;
    }
    this.error = '';
    this.segments = [];
    this.sources = [];
    this.references = [];
    this.loading = true;

    this.apiService.ask(q).subscribe(
      (res) => {
        this.segments = splitAnswer(res.answer);
        this.sources = res.sources;
        this.references = res.references || [];
        this.found = res.found !== false;
        this.retrieval = res.retrieval || '';
        this.loading = false;
      },
      (err) => {
        this.error = errorMessage(err, 'Could not get an answer from the server.');
        this.loading = false;
      }
    );
  }

  useExample(text: string): void {
    this.question = text;
  }

  percent(score: number): string {
    return `${Math.round(score * 100)}%`;
  }
}
