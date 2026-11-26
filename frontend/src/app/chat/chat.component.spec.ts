import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { ChatComponent } from './chat.component';

describe('ChatComponent', () => {
  let fixture: ComponentFixture<ChatComponent>;
  let component: ChatComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, FormsModule],
      declarations: [ChatComponent]
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('/files')).flush({ files: [
      { name: 'can-bus.pdf', size: 1500, indexed: true, chunks: 2 },
      { name: 'spi.txt', size: 40, indexed: false, chunks: 0 },
      { name: 'empty.txt', size: 0, indexed: true, chunks: 0 }
    ] });
    fixture.detectChanges();
  });

  it('lists knowledge-base documents and offers to index unindexed ones', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('can-bus.pdf');
    expect(text).toContain('2 chunks');
    expect(text).toContain('not indexed');
    expect(text).toContain('no text found');
    expect(component.unindexedCount).toBe(1); // the empty file cannot be indexed, so it is not offered
  });

  it('validates the question before calling the backend', () => {
    component.question = '   ';
    component.ask();
    expect(component.error).toBe('Type a question first.');
    component.question = 'x'.repeat(2001);
    component.ask();
    expect(component.error).toContain('too long');
    http.expectNone((r) => r.url.endsWith('/chat'));
  });

  it('shows the answer with source references and match scores', () => {
    component.question = 'Which identifier wins arbitration?';
    component.ask();
    const req = http.expectOne((r) => r.url.endsWith('/chat'));
    expect(req.request.body).toEqual({ question: 'Which identifier wins arbitration?' });
    req.flush({
      answer: 'The lowest identifier wins.', sources: ['can-bus.pdf'], truncated: false, found: true, retrieval: 'semantic',
      references: [{ file: 'can-bus.pdf', chunk: 1, score: 0.87, preview: 'Arbitration on the CAN bus' }]
    });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('The lowest identifier wins.');
    expect(text).toContain('Semantic search');
    expect(text).toContain('can-bus.pdf');
    expect(text).toContain('87% match');
    expect(component.loading).toBeFalse();
  });

  it('says clearly when the documents do not contain the answer', () => {
    component.question = 'quantum gravity';
    component.ask();
    http.expectOne((r) => r.url.endsWith('/chat')).flush({
      answer: 'Information not available in institutional database.', sources: [], truncated: false,
      found: false, retrieval: 'semantic', references: []
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('not found in the uploaded documents');
  });

  it('shows the backend error message when the request fails', () => {
    component.question = 'UART';
    component.ask();
    http.expectOne((r) => r.url.endsWith('/chat')).flush({ error: 'Could not reach Ollama at http://127.0.0.1:11434. Is it running?' }, { status: 503, statusText: 'Unavailable' });
    expect(component.error).toContain('Could not reach Ollama');
    expect(component.loading).toBeFalse();
  });
});
