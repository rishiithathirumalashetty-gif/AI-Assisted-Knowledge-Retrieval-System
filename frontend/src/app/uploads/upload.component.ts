import { Component, OnDestroy } from '@angular/core';

import { ApiService } from '../api.service';
import { AnswerSegment, errorMessage, splitAnswer } from '../answer-format';
import { ElapsedTimer } from '../elapsed-timer';

/** Must match ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES and MAX_PDF_BYTES in backend/server.js. */
export const ALLOWED = ['.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.java', '.js', '.ts', '.py', '.go', '.rs',
  '.html', '.css', '.json', '.xml', '.yml', '.yaml', '.sql', '.sh', '.s', '.asm', '.ino', '.md', '.txt', '.pdf'];
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Returns an error message, or '' when the file can be uploaded. */
export function validateFile(file: File): string {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!ALLOWED.includes(ext)) {
    return `"${ext || 'no extension'}" files are not supported. Choose a PDF, text or source-code file.`;
  }
  const limit = ext === '.pdf' ? MAX_PDF_BYTES : MAX_BYTES;
  if (file.size > limit) {
    return `That file is larger than ${limit / 1024 / 1024} MB. Choose a smaller one.`;
  }
  return '';
}

/** Upload a source file and show the model's explanation of it. */
@Component({
  selector: 'app-upload',
  templateUrl: './upload.component.html',
  styleUrls: ['./upload.component.css']
})
export class UploadComponent implements OnDestroy {

  selectedFile: File | null = null;
  segments: AnswerSegment[] = [];
  rawAnswer = '';
  truncated = false;
  sources: string[] = [];
  loading = false;
  stage: 'uploading' | 'analysing' | '' = '';
  error = '';
  dragging = false;
  copied = false;
  readonly timer = new ElapsedTimer();

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

    this.error = validateFile(file);
    if (this.error) { return; }
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
    this.sources = [];
    this.rawAnswer = '';
    this.loading = true;
    this.timer.start();
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
            this.sources = result.sources || [];
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
    if (bytes < 1024) { return `${bytes} B`; }
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  ngOnDestroy(): void {
    this.timer.stop();
  }

  private finish(): void {
    this.timer.stop();
    this.loading = false;
    this.stage = '';
  }
}
