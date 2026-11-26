import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

import { environment } from '../environments/environment';

export interface UploadResponse {
  message: string; fileName: string; size: number;
  /** true when the document was chunked and embedded for semantic search */
  indexed: boolean; chunks: number; indexError?: string;
}
/** One retrieved chunk that was given to the model as context. */
export interface SourceReference { file: string; chunk: number; score: number; preview: string; }
export interface ChatResponse {
  answer: string; sources: string[]; truncated: boolean;
  references?: SourceReference[];
  /** false when no uploaded document matched the question */
  found?: boolean;
  retrieval?: 'semantic' | 'keyword' | 'conversation';
}
export interface HealthResponse {
  status: string; model: string; ollama: 'reachable' | 'unreachable';
  embedModel?: string; indexedChunks?: number;
}
export interface KnowledgeFile { name: string; size: number; chunks: number; }

/** Thin wrapper around the backend REST API (see backend/server.js). */
@Injectable({
  providedIn: 'root'
})
export class ApiService {

  private readonly base = environment.apiUrl;

  constructor(private http: HttpClient) { }

  /** Upload one file into the backend's knowledge folder. */
  uploadFile(data: FormData): Observable<UploadResponse> {
    return this.http.post<UploadResponse>(`${this.base}/upload`, data);
  }

  /** Ask the model to explain a file that was already uploaded. */
  explainFile(fileName: string): Observable<ChatResponse> {
    return this.http.post<ChatResponse>(`${this.base}/chat`, {
      question: 'Explain this code line by line',
      fileName
    });
  }

  /** Ask a question that is answered from the files in the knowledge folder. */
  ask(question: string): Observable<ChatResponse> {
    return this.http.post<ChatResponse>(`${this.base}/chat`, { question });
  }

  /** Documents in the knowledge folder with their number of indexed chunks. */
  listFiles(): Observable<{ files: KnowledgeFile[] }> {
    return this.http.get<{ files: KnowledgeFile[] }>(`${this.base}/files`);
  }

  /** Re-embed documents that are new or were not indexed yet. */
  reindex(): Observable<{ indexed: { fileName: string; chunks: number }[]; errors: { fileName: string; error: string }[] }> {
    return this.http.post<any>(`${this.base}/reindex`, {});
  }

  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.base}/health`);
  }
}
