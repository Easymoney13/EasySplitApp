const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { evaluateReceiptAccuracy, HEBREW_OCR_ACCEPTANCE_TARGET } = require('../lib/ocrQuality');

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

test('real Tesseract pipeline exceeds the 96% Hebrew synthetic-fixture acceptance target', { timeout: 45_000 }, async () => {
  const fixtures = [
    'hebrew-receipt.synthetic.png.base64',
    'hebrew-receipt.skew.png.base64',
    'hebrew-receipt.thermal.png.base64',
    'hebrew-receipt.mobile.jpg.base64',
  ];
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-hebrew-ocr-'));
  const originalWorkingDirectory = process.cwd();

  try {
    // Tesseract.js caches language data in cwd under Node. Keep that cache out
    // of the repository while exercising the same browser worker code.
    process.chdir(temporaryDirectory);
    const { scanBillImagesInBrowser } = loadBrowserOcrModule();
    const expected = {
      items: [
        { name: 'סלט יווני', price: 45 },
        { name: 'פיצה מרגריטה', price: 62 },
        { name: 'קולה זירו', price: 14 },
      ],
    };
    let correctRows = 0;
    let expectedRows = 0;
    for (const fixture of fixtures) {
      const fixtureBase64 = fs.readFileSync(path.resolve(__dirname, 'fixtures', fixture), 'utf8').replace(/\s+/g, '');
      const imagePath = path.join(temporaryDirectory, fixture.replace('.base64', ''));
      fs.writeFileSync(imagePath, Buffer.from(fixtureBase64, 'base64'));
      const receipt = await scanBillImagesInBrowser([imagePath], 18_000);
      assert.ok(receipt, `${fixture} must produce a readable, reconciled Hebrew draft`);
      const result = evaluateReceiptAccuracy(expected, receipt);
      correctRows += result.correctRows;
      expectedRows += result.expectedRows;
      assert.equal(receipt.receiptTotal, 121);
      assert.equal(receipt.ocrQuality?.readable, true);
      assert.equal(receipt.ocr?.nameVerificationStatus, 'dual-hebrew-pass-agreement');
    }
    const benchmark = { accuracy: correctRows / expectedRows };
    assert.ok(
      benchmark.accuracy >= HEBREW_OCR_ACCEPTANCE_TARGET,
      `Hebrew OCR accuracy ${benchmark.accuracy} is below ${HEBREW_OCR_ACCEPTANCE_TARGET}`,
    );
  } finally {
    process.chdir(originalWorkingDirectory);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Hebrew OCR parser recognizes spaced totals and excludes summary rows from purchased items', () => {
  const { parseReceiptText } = loadBrowserOcrModule();
  const receipt = parseReceiptText([
    'קפה 12.00',
    'עוגה 24.00',
    'סה " כ פריטים 36.00',
    'יתרה 36.00',
  ].join('\n'));
  assert.ok(receipt);
  assert.equal(receipt.receiptTotal, 36);
  assert.deepEqual(receipt.items.map(({ name, price }) => ({ name, price })), [
    { name: 'קפה', price: 12 },
    { name: 'עוגה', price: 24 },
  ]);
});

test('Hebrew OCR preserves explicitly printed restaurant identity outside purchased rows', () => {
  const { parseReceiptText } = loadBrowserOcrModule();
  const receipt = parseReceiptText([
    'קפה הבדיקה',
    'ח.פ: 515123456',
    'כתובת: רחוב הדוגמה 12 תל אביב',
    'טלפון: 03-5551234',
    'קפה 12.00',
    'סה"כ 12.00',
  ].join('\n'));
  assert.ok(receipt);
  assert.deepEqual(receipt.restaurant, {
    printedName: 'קפה הבדיקה',
    businessId: '515123456',
    address: 'רחוב הדוגמה 12 תל אביב',
    phone: '03-5551234',
    source: 'client-tesseract',
  });
  assert.deepEqual(receipt.items.map(({ name }) => name), ['קפה']);
});

test('Hebrew OCR never turns numeric restaurant metadata into purchased items', () => {
  const { parseReceiptText } = loadBrowserOcrModule();
  const receipt = parseReceiptText([
    'קפה הבדיקה',
    'כתובת: הרצל 12',
    'מספר שולחן 7',
    'טלפון: 03-5551234',
    'ח.פ: 515123456',
    'קפה 12.00',
    'סה"כ 12.00',
  ].join('\n'));
  assert.ok(receipt);
  assert.equal(receipt.restaurant.address, 'הרצל 12');
  assert.deepEqual(receipt.items.map(({ name, price }) => ({ name, price })), [
    { name: 'קפה', price: 12 },
  ]);
});

test('Hebrew OCR recognizes business identifiers printed with gershayim', () => {
  const { parseReceiptText } = loadBrowserOcrModule();
  const receipt = parseReceiptText([
    'מסעדת ניסיון',
    'ח״פ: 515123456',
    'מנה 25.00',
    'סה״כ 25.00',
  ].join('\n'));
  assert.ok(receipt);
  assert.equal(receipt.restaurant.businessId, '515123456');
});
