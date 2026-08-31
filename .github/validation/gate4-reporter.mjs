import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateGate4Report } from './gate4-contract.mjs';

function json(res, status, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

async function serve(outputDir, port) {
  await mkdir(outputDir, { recursive: true });
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/report') return json(res, 404, { error: 'Not found' });

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const report = JSON.parse(raw);
        if (!['ios', 'android'].includes(report.platform)) throw new Error('Invalid platform');
        const destination = resolve(outputDir, `${report.platform}-result.json`);
        await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : 'Invalid report' });
      }
    });
  });
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`Gate 4 reporter listening on ${port}\n`);
  });
}

async function waitForReport(filePath, expectedPlatform, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    let report;
    try {
      report = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      lastError = error;
      await delay(500);
      continue;
    }
    try {
      validateGate4Report(report, expectedPlatform);
      for (const marker of report.markers) process.stdout.write(`${marker}\n`);
      process.stdout.write(`GATE4_NATIVE_PLATFORM=${expectedPlatform}\n`);
      return;
    } catch (error) {
      lastError = error;
      if (report.status === 'FAIL') throw error;
    }
    await delay(500);
  }
  throw lastError || new Error(`Timed out waiting for ${expectedPlatform} Gate 4 report`);
}

const [command, first, second, third] = process.argv.slice(2);
if (command === 'serve') {
  await serve(resolve(first), Number(second || 3904));
} else if (command === 'wait') {
  await waitForReport(resolve(first), second, Number(third || 120_000));
} else {
  throw new Error('Usage: gate4-reporter.mjs serve <output-dir> [port] | wait <report-file> <platform> [timeout-ms]');
}
