import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { AppComponent } from './app.component';

describe('AppComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      declarations: [AppComponent],
      schemas: [NO_ERRORS_SCHEMA] // child components are tested on their own
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  it('should create the app and render the title', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('AI Source Code Explainer');
  });

  it('shows the model as ready when Ollama is reachable', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('/health')).flush({ status: 'ok', model: 'qwen2.5-coder:7b', ollama: 'reachable' });
    expect(fixture.componentInstance.statusText).toBe('Ready · qwen2.5-coder:7b');
  });

  it('reports when the backend is down', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('/health')).error(new ErrorEvent('offline'));
    expect(fixture.componentInstance.status).toBe('offline');
  });
});
