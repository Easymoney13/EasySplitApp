import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MIN_PAGE_ALIGNMENT = 16 * 1024;

export function parseBundlePageAlignment(text) {
  const match = String(text || '').match(/PAGE_ALIGNMENT_(\d+)K/);
  return match ? Number(match[1]) * 1024 : null;
}

export function parseElfLoadAlignments(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*LOAD\s/.test(line))
    .map((line) => line.trim().split(/\s+/).at(-1))
    .map((token) => Number(token))
    .filter((value) => Number.isFinite(value));
}

export function validateElfLoadAlignments(library, alignments) {
  if (!Array.isArray(alignments) || alignments.length === 0) {
    throw new Error(`${library}: readelf returned no LOAD segments`);
  }
  const invalid = alignments.filter((value) => value < MIN_PAGE_ALIGNMENT);
  if (invalid.length > 0) {
    throw new Error(`${library}: LOAD alignment below 16 KB (${invalid.join(', ')})`);
  }
}

function listNativeLibraries(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.so')) results.push(full);
    }
  }
  return results.sort();
}

function readProgramHeaders(library) {
  const result = spawnSync('readelf', ['-lW', library], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${library}: readelf failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

export function auditAndroidPageAlignment({ extractedRoot, bundleConfigPath, reportPath }) {
  const nativeRoot = path.join(extractedRoot, 'base', 'lib');
  const libraries = listNativeLibraries(nativeRoot);
  const bundleConfig = fs.readFileSync(bundleConfigPath, 'utf8');
  const bundlePageAlignment = parseBundlePageAlignment(bundleConfig);
  const issues = [];
  const results = [];

  if (libraries.length > 0 && bundlePageAlignment !== MIN_PAGE_ALIGNMENT) {
    issues.push(`AAB requests ${bundlePageAlignment || 'unknown'}-byte ZIP alignment instead of 16384`);
  }

  for (const library of libraries) {
    const relativePath = path.relative(extractedRoot, library);
    try {
      const alignments = parseElfLoadAlignments(readProgramHeaders(library));
      validateElfLoadAlignments(relativePath, alignments);
      results.push({ path: relativePath, loadAlignments: alignments, status: 'PASS' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(message);
      results.push({ path: relativePath, status: 'FAIL', error: message });
    }
  }

  const report = {
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    requiredPageAlignment: MIN_PAGE_ALIGNMENT,
    bundlePageAlignment: libraries.length === 0 ? 'NOT_APPLICABLE' : bundlePageAlignment,
    nativeLibraryCount: libraries.length,
    libraries: results,
    issues,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (issues.length > 0) {
    throw new Error(`Android 16 KB page-size review failed: ${issues.join('; ')}`);
  }
  return report;
}

function main() {
  const [extractedRoot, bundleConfigPath, reportPath] = process.argv.slice(2);
  if (!extractedRoot || !bundleConfigPath || !reportPath) {
    throw new Error('Usage: verify-android-page-alignment.mjs <extracted-aab-root> <bundle-config> <report-json>');
  }
  auditAndroidPageAlignment({ extractedRoot, bundleConfigPath, reportPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
