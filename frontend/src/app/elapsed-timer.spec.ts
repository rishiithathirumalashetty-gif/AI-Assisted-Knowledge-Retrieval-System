import { fakeAsync, tick } from '@angular/core/testing';

import { ElapsedTimer } from './elapsed-timer';

describe('ElapsedTimer', () => {
  it('counts seconds and stops cleanly', fakeAsync(() => {
    const timer = new ElapsedTimer();
    timer.start();
    tick(3000);
    expect(timer.seconds).toBe(3);
    timer.stop();
    tick(2000);
    expect(timer.seconds).toBe(3);
    timer.start();
    expect(timer.seconds).toBe(0);
    timer.stop();
  }));
});
