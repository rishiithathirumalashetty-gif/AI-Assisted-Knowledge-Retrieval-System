/** A piece of a model answer: normal text or a fenced code block. */
export interface AnswerSegment {
  type: 'text' | 'code';
  content: string;
}

/**
 * Split a model answer into text and ``` code blocks, so the template can show
 * code in a monospace box. Plain data only (no HTML), so nothing in the model's
 * output can inject markup into the page.
 */
export function splitAnswer(answer: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(answer)) !== null) {
    if (match.index > last) {
      segments.push({ type: 'text', content: answer.slice(last, match.index).trim() });
    }
    segments.push({ type: 'code', content: match[1].replace(/\n$/, '') });
    last = match.index + match[0].length;
  }
  if (last < answer.length) {
    segments.push({ type: 'text', content: answer.slice(last).trim() });
  }
  return segments.filter((s) => s.content.length > 0);
}

/** Pick the most useful message from a failed HTTP response. */
export function errorMessage(err: any, fallback: string): string {
  if (err && err.status === 0) {
    return 'Cannot reach the backend. Start it with "npm start" in the backend folder.';
  }
  return (err && err.error && err.error.error) || fallback;
}
