import { ComponentFixture, TestBed } from '@angular/core/testing';

import { HttpClientTestingModule } from '@angular/common/http/testing';

import { UploadComponent, validateFile } from './upload.component';

describe('UploadComponent', () => {
  let component: UploadComponent;
  let fixture: ComponentFixture<UploadComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ HttpClientTestingModule ],
      declarations: [ UploadComponent ]
    })
    .compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(UploadComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('accepts PDFs up to 10 MB and rejects other large or unsupported files', () => {
    const f = (name: string, size: number) => ({ name, size } as File);
    expect(validateFile(f('notes.pdf', 5 * 1024 * 1024))).toBe('');
    expect(validateFile(f('main.c', 1000))).toBe('');
    expect(validateFile(f('big.pdf', 11 * 1024 * 1024))).toContain('10 MB');
    expect(validateFile(f('big.txt', 3 * 1024 * 1024))).toContain('2 MB');
    expect(validateFile(f('virus.exe', 10))).toContain('not supported');
  });
});
