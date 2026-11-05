import { gbText, sizeText } from '../format-bytes';

describe('format-bytes', () => {
  it('shows MB under a gigabyte and GB from one up', () => {
    expect(sizeText(412_000_000)).toBe('412 MB');
    expect(sizeText(1_000_000_000)).toBe('1.0 GB');
    expect(sizeText(38_200_000_000)).toBe('38.2 GB');
  });

  it('keeps the bare GB figure', () => {
    expect(gbText(1_234_000_000)).toBe('1.2');
  });
});
