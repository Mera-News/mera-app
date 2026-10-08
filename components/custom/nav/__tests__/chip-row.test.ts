import { CHIP_MIN_OPACITY, CHIP_ROW_INSET, chipOpacity, revealOffset } from '../chip-row';

describe('chipOpacity', () => {
  it('leaves every chip the viewport fully shows at full strength, edges included', () => {
    expect(chipOpacity(0, 80, 390)).toBe(1);
    expect(chipOpacity(310, 80, 390)).toBe(1);
    expect(chipOpacity(14, 80, 390)).toBe(1);
  });

  it('fades only a chip the edge cuts, by its visible share', () => {
    expect(chipOpacity(-20, 80, 390)).toBeCloseTo(0.75);
    expect(chipOpacity(350, 80, 390)).toBeCloseTo(0.5);
  });

  it('never fades a cut chip to nothing', () => {
    expect(chipOpacity(-75, 80, 390)).toBe(CHIP_MIN_OPACITY);
    expect(chipOpacity(385, 80, 390)).toBe(CHIP_MIN_OPACITY);
  });
});

describe('revealOffset', () => {
  // Content 700 wide in a 390 viewport.
  it('does not move a row that already shows the chip', () => {
    expect(revealOffset(100, 80, 0, 390, 700)).toBeNull();
    expect(revealOffset(14, 80, 0, 390, 700)).toBeNull();
  });

  it('scrolls just enough to show a chip past either end', () => {
    expect(revealOffset(400, 80, 0, 390, 700)).toBe(400 + 80 + CHIP_ROW_INSET - 390);
    expect(revealOffset(100, 80, 200, 390, 700)).toBe(100 - CHIP_ROW_INSET);
  });

  it('never scrolls past the content, so no blank band opens at either end', () => {
    expect(revealOffset(650, 80, 0, 390, 700)).toBe(310);
    expect(revealOffset(5, 80, 50, 390, 700)).toBe(0);
    expect(revealOffset(300, 80, 0, 390, 300)).toBeNull();
  });
});
