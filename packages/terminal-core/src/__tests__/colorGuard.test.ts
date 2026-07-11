import { shouldBlockColorOsc, COLOR_OSC_CODES } from '../colorGuard';

describe('shouldBlockColorOsc', () => {
  it('never blocks when the pane is not locked (normal terminal)', () => {
    expect(shouldBlockColorOsc(false, 'rgb:1e1e/1e1e/2e2e')).toBe(false); // OSC 11 set bg
    expect(shouldBlockColorOsc(false, '1;rgb:ff/00/00')).toBe(false);     // OSC 4 set palette
    expect(shouldBlockColorOsc(false, '')).toBe(false);                   // OSC 104 reset
    expect(shouldBlockColorOsc(false, '?')).toBe(false);                  // query
  });

  it('blocks a color SET while locked so our theme is preserved', () => {
    expect(shouldBlockColorOsc(true, 'rgb:1e1e/1e1e/2e2e')).toBe(true); // OSC 10/11 set fg/bg
    expect(shouldBlockColorOsc(true, '1;rgb:ff/00/00')).toBe(true);     // OSC 4 set palette index 1
    expect(shouldBlockColorOsc(true, '#00ff00')).toBe(true);            // hex form
  });

  it('blocks a color RESET while locked (reset would clobber to defaults too)', () => {
    expect(shouldBlockColorOsc(true, '')).toBe(true);  // OSC 104 reset-all
    expect(shouldBlockColorOsc(true, '1')).toBe(true); // OSC 104 reset index 1
  });

  it('passes a color QUERY through even while locked, so the program renders correctly', () => {
    expect(shouldBlockColorOsc(true, '?')).toBe(false);   // OSC 11;? query bg
    expect(shouldBlockColorOsc(true, '1;?')).toBe(false); // OSC 4;1;? query palette index 1
  });

  it('covers the standard color-control OSC identifiers (sets + resets)', () => {
    expect(COLOR_OSC_CODES).toEqual([4, 5, 10, 11, 12, 17, 19, 104, 105, 110, 111, 112, 117, 119]);
  });
});
