import { Component, OnInit } from '@angular/core';

import { ApiService } from './api.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {

  /** Which screen is showing. */
  tab: 'explain' | 'ask' = 'explain';

  /** Backend / model status shown in the header. */
  status: 'checking' | 'online' | 'model-offline' | 'offline' = 'checking';
  modelName = '';

  constructor(private api: ApiService) { }

  ngOnInit(): void {
    this.checkHealth();
  }

  checkHealth(): void {
    this.status = 'checking';
    this.api.health().subscribe(
      (h) => {
        this.modelName = h.model;
        this.status = h.ollama === 'reachable' ? 'online' : 'model-offline';
      },
      () => { this.status = 'offline'; }
    );
  }

  get statusText(): string {
    switch (this.status) {
      case 'online': return `Ready · ${this.modelName}`;
      case 'model-offline': return 'Backend running, Ollama not reachable';
      case 'offline': return 'Backend not reachable';
      default: return 'Checking backend…';
    }
  }
}
