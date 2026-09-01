import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBundlePageAlignment,
  parseElfLoadAlignments,
  validateElfLoadAlignments,
} from '../scripts/verify-android-page-alignment.mjs';

test('bundletool page alignment parser distinguishes 16 KB from 4 KB', () => {
  assert.equal(parseBundlePageAlignment('page_alignment: PAGE_ALIGNMENT_16K'), 16384);
  assert.equal(parseBundlePageAlignment('page_alignment: PAGE_ALIGNMENT_4K'), 4096);
  assert.equal(parseBundlePageAlignment('optimizations {}'), null);
});

test('ELF LOAD parser reads wide readelf program headers', () => {
  const output = [
    '  LOAD 0x000000 0x0000000000000000 0x0000000000000000 0x1234 0x1234 R E 0x4000',
    '  LOAD 0x004000 0x0000000000004000 0x0000000000004000 0x0200 0x0300 RW  0x10000',
  ].join('\n');
  assert.deepEqual(parseElfLoadAlignments(output), [16384, 65536]);
});

test('ELF validator rejects a 4 KB LOAD segment and accepts 16 KB or higher', () => {
  assert.doesNotThrow(() => validateElfLoadAlignments('libok.so', [16384, 65536]));
  assert.throws(
    () => validateElfLoadAlignments('libbad.so', [16384, 4096]),
    /libbad\.so: LOAD alignment below 16 KB \(4096\)/,
  );
  assert.throws(
    () => validateElfLoadAlignments('libempty.so', []),
    /readelf returned no LOAD segments/,
  );
});
