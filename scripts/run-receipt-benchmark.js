#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadBrowserOcrModule() {
  const filename = path.resolve(__dirname, '../lib/ocrScanner.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled, filename);
  return loaded.exports;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function main() {
  const datasetDirectory = path.resolve(process.argv[2] || '');
  const outputPath = path.resolve(process.argv[3] || 'receipt-benchmark.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(datasetDirectory, 'manifest.json'), 'utf8'));
  const { scanBillImagesInBrowser } = loadBrowserOcrModule();
  const selectedReceipts = process.env.OCR_BENCHMARK_HEBREW_ONLY === '1'
    ? (manifest.receipts || []).filter((entry) => entry.language.includes('he'))
    : (manifest.receipts || []);
  const receiptLimit = Math.max(0, Number(process.env.OCR_BENCHMARK_LIMIT) || selectedReceipts.length);
  const receipts = selectedReceipts.slice(0, receiptLimit);
  const results = new Array(receipts.length);
  const concurrency = Math.max(1, Math.min(3, Number(process.env.OCR_BENCHMARK_CONCURRENCY) || 2));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < receipts.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = receipts[index];
      const imagePath = path.join(datasetDirectory, entry.file);
      const startedAt = Date.now();
      const parsed = await scanBillImagesInBrowser([imagePath], 30_000);
      const durationMs = Date.now() - startedAt;
      results[index] = {
        id: entry.id,
        file: entry.file,
        expectedLanguage: entry.language,
        expectedTotal: entry.expectedTotal ?? null,
        accepted: Boolean(parsed),
        durationMs,
        output: parsed ? {
          storeName: parsed.storeName,
          currency: parsed.currency,
          documentLanguage: parsed.documentLanguage,
          receiptTotal: parsed.receiptTotal ?? null,
          itemCount: parsed.items.length,
          items: parsed.items.map(({ name, price }) => ({ name, price })),
          quality: parsed.ocrQuality,
          verificationStatus: parsed.ocr?.nameVerificationStatus || null,
          confidence: parsed.ocr?.confidence ?? null,
        } : null,
      };
      process.stderr.write(`${entry.id}/${receipts.length} ${parsed ? 'accepted' : 'rejected'} ${durationMs}ms\n`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const durations = results.map((result) => result.durationMs);
  const accepted = results.filter((result) => result.accepted);
  const hebrew = results.filter((result) => result.expectedLanguage.includes('he'));
  const hebrewAccepted = hebrew.filter((result) => result.accepted);
  const withExpectedTotal = results.filter((result) => Number.isFinite(result.expectedTotal));
  const exactTotalMatches = withExpectedTotal.filter((result) => (
    result.accepted
    && Number.isFinite(result.output?.receiptTotal)
    && Math.abs(result.output.receiptTotal - result.expectedTotal) <= 0.01
  ));
  const hebrewWithExpectedTotal = hebrew.filter((result) => Number.isFinite(result.expectedTotal));
  const hebrewExactTotalMatches = hebrewWithExpectedTotal.filter((result) => (
    result.accepted
    && Number.isFinite(result.output?.receiptTotal)
    && Math.abs(result.output.receiptTotal - result.expectedTotal) <= 0.01
  ));
  const report = {
    generatedAt: new Date().toISOString(),
    engine: 'EasySplit client Tesseract pipeline',
    dataset: manifest.dataset,
    summary: {
      totalReceipts: results.length,
      acceptedReceipts: accepted.length,
      acceptanceRate: accepted.length / results.length,
      hebrewReceipts: hebrew.length,
      acceptedHebrewReceipts: hebrewAccepted.length,
      hebrewAcceptanceRate: hebrewAccepted.length / hebrew.length,
      receiptsWithExpectedTotal: withExpectedTotal.length,
      exactTotalMatches: exactTotalMatches.length,
      exactTotalAccuracy: exactTotalMatches.length / withExpectedTotal.length,
      hebrewExactTotalMatches: hebrewExactTotalMatches.length,
      hebrewExactTotalAccuracy: hebrewExactTotalMatches.length / hebrewWithExpectedTotal.length,
      medianDurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
    },
    results,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
