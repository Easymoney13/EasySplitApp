#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { textSimilarity } = require('../lib/ocrQuality');

function amountInCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function evaluateReceipt(expected, benchmarkResult) {
  const actualItems = benchmarkResult?.output?.items || [];
  const unusedActualIndexes = new Set(actualItems.map((_, index) => index));
  let exactPriceRows = 0;
  let correctNameAndPriceRows = 0;
  let auditedNameRows = 0;

  for (const expectedItem of expected.items) {
    const expectedCents = amountInCents(expectedItem.price);
    const candidates = [...unusedActualIndexes]
      .map((index) => ({
        index,
        item: actualItems[index],
        similarity: textSimilarity(expectedItem.name, actualItems[index]?.name),
      }))
      .filter(({ item }) => amountInCents(item?.price) === expectedCents)
      .sort((left, right) => right.similarity - left.similarity);
    if (candidates.length) {
      exactPriceRows += 1;
      unusedActualIndexes.delete(candidates[0].index);
      if (expectedItem.nameAudited !== false && candidates[0].similarity >= 0.9) {
        correctNameAndPriceRows += 1;
      }
    }
    if (expectedItem.nameAudited !== false) auditedNameRows += 1;
  }

  const expectedTotalCents = amountInCents(expected.receiptTotal);
  const actualTotalCents = amountInCents(benchmarkResult?.output?.receiptTotal);
  return {
    id: expected.id,
    accepted: Boolean(benchmarkResult?.accepted),
    expectedRows: expected.items.length,
    auditedNameRows,
    actualRows: actualItems.length,
    exactPriceRows,
    correctNameAndPriceRows,
    exactTotal: expectedTotalCents !== null && expectedTotalCents === actualTotalCents,
    durationMs: benchmarkResult?.durationMs ?? null,
  };
}

function main() {
  const groundTruthPath = path.resolve(process.argv[2] || '');
  const benchmarkPath = path.resolve(process.argv[3] || '');
  const groundTruth = JSON.parse(fs.readFileSync(groundTruthPath, 'utf8'));
  const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));
  const benchmarkById = new Map(benchmark.results.map((result) => [result.id, result]));
  const receipts = groundTruth.receipts.map((expected) => evaluateReceipt(expected, benchmarkById.get(expected.id)));
  const sums = receipts.reduce((total, receipt) => ({
    expectedRows: total.expectedRows + receipt.expectedRows,
    auditedNameRows: total.auditedNameRows + receipt.auditedNameRows,
    actualRows: total.actualRows + receipt.actualRows,
    exactPriceRows: total.exactPriceRows + receipt.exactPriceRows,
    correctNameAndPriceRows: total.correctNameAndPriceRows + receipt.correctNameAndPriceRows,
    acceptedReceipts: total.acceptedReceipts + Number(receipt.accepted),
    exactTotalReceipts: total.exactTotalReceipts + Number(receipt.exactTotal),
  }), {
    expectedRows: 0,
    auditedNameRows: 0,
    actualRows: 0,
    exactPriceRows: 0,
    correctNameAndPriceRows: 0,
    acceptedReceipts: 0,
    exactTotalReceipts: 0,
  });
  const report = {
    benchmark: benchmarkPath,
    evaluatedReceipts: receipts.length,
    ...sums,
    acceptanceRate: sums.acceptedReceipts / receipts.length,
    exactTotalAccuracy: sums.exactTotalReceipts / receipts.length,
    exactPriceRecall: sums.exactPriceRows / sums.expectedRows,
    correctRowRecall: sums.correctNameAndPriceRows / sums.auditedNameRows,
    extraOrIncorrectRows: Math.max(0, sums.actualRows - sums.correctNameAndPriceRows),
    receipts,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
