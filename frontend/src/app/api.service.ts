import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

import { environment } from '../environments/environment';

export interface UploadResponse { message: string; fileName: string; size: number; }
export interface ChatResponse { answer: string; sources: string[]; truncated: boolean; }
export interface HealthResponse { status: string; model: string; ollama: 'reachable' | 'unreachable'; }

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

  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.base}/health`);
  }
}
