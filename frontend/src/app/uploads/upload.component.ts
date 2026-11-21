import { Component } from '@angular/core';

import { ApiService } from '../api.service';
import { AnswerSegment, errorMessage, splitAnswer } from '../answer-format';

/** Must match ALLOWED_EXTENSIONS and MAX_UPLOAD_BYTES in backend/server.js. */
const ALLOWED = ['.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.java', '.js', '.ts', '.py', '.go', '.rs',
  '.html', '.css', '.json', '.xml', '.yml', '.yaml', '.sql', '.sh', '.s', '.asm', '.ino', '.md', '.txt'];
const MAX_BYTES = 2 * 1024 * 1024;

/** Upload a source file and show the model's explanation of it. */
@Component({
  selector: 'app-upload',
  templateUrl: './upload.component.html',
  styleUrls: ['./upload.component.css']
})
export class UploadComponent {

  selectedFile: File | null = null;
  segments: AnswerSegment[] = [];
  rawAnswer = '';
  truncated = false;
  loading = false;
  stage: 'uploading' | 'analysing' | '' = '';
  error = '';
  dragging = false;
  copied = false;

  constructor(private apiService: ApiService) { }

  onFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setFile(input.files && input.files.length ? input.files[0] : null);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
    const files = event.dataTransfer ? event.dataTransfer.files : null;
    this.setFile(files && files.length ? files[0] : null);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging = true;
  }

  clearFile(): void {
    this.selectedFile = null;
    this.error = '';
  }

  /** Validate on the client first so people get instant feedback. */
  private setFile(file: File | null): void {
    this.error = '';
    this.selectedFile = null;
    if (!file) { return; }

    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    if (!ALLOWED.includes(ext)) {
      this.error = `"${ext || 'no extension'}" files are not supported. Choose a text or source-code file.`;
      return;
    }
    if (file.size > MAX_BYTES) {
      this.error = 'That file is larger than 2 MB. Choose a smaller one.';
      return;
    }
    this.selectedFile = file;
  }

  /** Upload the file, then ask the backend to explain it. */
  uploadFile(): void {
    if (!this.selectedFile) {
      this.error = 'Please choose a file first.';
      return;
    }

    const formData = new FormData();
    formData.append('file', this.selectedFile);

    this.error = '';
    this.segments = [];
    this.rawAnswer = '';
    this.loading = true;
    this.stage = 'uploading';

    this.apiService.uploadFile(formData).subscribe(
      (uploaded) => {
        this.stage = 'analysing';
        // Use the name the server stored (it may be sanitised).
        this.apiService.explainFile(uploaded.fileName).subscribe(
          (result) => {
            this.rawAnswer = result.answer;
            this.segments = splitAnswer(result.answer);
            this.truncated = result.truncated;
            this.finish();
          },
          (err) => {
            this.error = errorMessage(err, 'Could not get an explanation from the server.');
            this.finish();
          }
        );
      },
      (err) => {
        this.error = errorMessage(err, 'File upload failed.');
        this.finish();
      }
    );
  }

  copyAnswer(): void {
    if (!navigator.clipboard) { return; }
    navigator.clipboard.writeText(this.rawAnswer).then(() => {
      this.copied = true;
      setTimeout(() => (this.copied = false), 1800);
    });
  }

  formatSize(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }

  private finish(): void {
    this.loading = false;
    this.stage = '';
  }
}
