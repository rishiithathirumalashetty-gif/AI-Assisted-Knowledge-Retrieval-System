import { Component } from '@angular/core';

import { ApiService } from '../api.service';
import { AnswerSegment, errorMessage, splitAnswer } from '../answer-format';

/** Ask a question that is answered from the documents in the backend's knowledge folder. */
@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent {

  question = '';
  segments: AnswerSegment[] = [];
  sources: string[] = [];
  loading = false;
  error = '';

  readonly examples = ['What does the UART peripheral do?', 'How do I configure a GPIO pin as output?'];

  constructor(private apiService: ApiService) { }

  ask(): void {
    const q = this.question.trim();
    if (!q) {
      this.error = 'Type a question first.';
      return;
    }
    this.error = '';
    this.segments = [];
    this.sources = [];
    this.loading = true;

    this.apiService.ask(q).subscribe(
      (res) => {
        this.segments = splitAnswer(res.answer);
        this.sources = res.sources;
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
}
