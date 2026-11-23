import { formatBytes, formatBytesExact } from '../formatBytes';

const KiB = 1024, MiB = 1024 ** 2, GiB = 1024 ** 3, TiB = 1024 ** 4;

describe('formatBytes', () => {
  test.each([
    [0, '0 B'],
    [20, '20 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10239, '10 KB'], // 9.999 KB rounds to 10.0, shown whole from 10 up
    [10240, '10 KB'],
    [262144, '256 KB'],
    [524288, '512 KB'],
    [1023.6 * KiB, '1 MB'], // would round to "1024 KB": promoted
    [MiB - 1, '1 MB'],
    [MiB, '1 MB'],
    [1.5 * MiB, '1.5 MB'],
    [GiB, '1 GB'],
    [2.25 * GiB, '2.3 GB'],
    [500 * GiB, '500 GB'],
    [TiB - 1, '1 TB'],
    [TiB, '1 TB'],
    [3 * 1024 * TiB, '3072 TB'], // TB is the largest unit: no promotion past it
  ])('%p -> %p', (bytes, text) => {
    expect(formatBytes(Math.round(bytes))).toBe(text);
  });

  test('accepts SFTP decimal u64 strings and bigints, including values past 2^53', () => {
    expect(formatBytes('262144')).toBe('256 KB');
    expect(formatBytes(' 20 ')).toBe('20 B');
    expect(formatBytes(BigInt(MiB))).toBe('1 MB');
    expect(formatBytes('18446744073709551615')).toBe('16777216 TB');
  });

  test('non-integer or negative input is shown as given', () => {
    expect(formatBytes('abc')).toBe('abc B');
    expect(formatBytes('-5')).toBe('-5 B');
    expect(formatBytes(-1)).toBe('-1 B');
    expect(formatBytes(NaN)).toBe('NaN B');
  });
});

describe('formatBytesExact', () => {
  test('groups digits with a fixed en-US locale and keeps u64 precision', () => {
    expect(formatBytesExact('262144')).toBe('262,144 bytes');
    expect(formatBytesExact(0)).toBe('0 bytes');
    expect(formatBytesExact(1)).toBe('1 byte');
    expect(formatBytesExact('18446744073709551615')).toBe('18,446,744,073,709,551,615 bytes');
    expect(formatBytesExact('x')).toBe('x bytes');
  });
});
