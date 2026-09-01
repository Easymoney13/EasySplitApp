import { createServer } from 'node:http';
import { access, appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { GATE4_CORE_MARKERS, GATE4_STAGES, validateGate4Report } from './gate4-contract.mjs';

function json(res, status, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

function validateEvidence(payload, expectedRunId, terminal) {
  if (!payload || typeof payload !== 'object') throw new Error('Gate 4 evidence is missing');
  if (!['ios', 'android'].includes(payload.platform)) throw new Error('Invalid platform');
  if (!expectedRunId || payload.runId !== expectedRunId) {
    throw new Error(`Expected Gate 4 run ${expectedRunId || 'unknown'}, received ${payload.runId || 'unknown'}`);
  }
  if (!GATE4_STAGES.includes(payload.stage)) throw new Error(`Invalid Gate 4 stage: ${payload.stage || 'missing'}`);
  const markers = Array.isArray(payload.markers) ? payload.markers : [];
  if (new Set(markers).size !== markers.length) throw new Error('Gate 4 markers contain duplicates');
  if (markers.some((marker, index) => marker !== GATE4_CORE_MARKERS[index])) {
    throw new Error('Gate 4 markers must be an ordered prefix of the contract');
  }
  if (terminal) {
    if (!['PASS', 'FAIL'].includes(payload.status)) throw new Error('Invalid terminal status');
    if (payload.status === 'PASS') validateGate4Report(payload, payload.platform, expectedRunId);
    if (payload.status === 'FAIL' && !payload.error) throw new Error('A failed Gate 4 report requires an error');
  } else if (!['RUNNING', 'PASS', 'FAIL'].includes(payload.status)) {
    throw new Error('Invalid progress status');
  } else if (payload.status === 'FAIL' && !payload.error) {
    throw new Error('Failed Gate 4 progress requires an error');
  }
}

function validateProgressTransition(evidence, previous, seen) {
  const stageIndex = GATE4_STAGES.indexOf(evidence.stage);
  const markerCount = evidence.markers.length;
  const expectedMarkerCount = evidence.status === 'PASS' ? stageIndex : Math.max(0, stageIndex - 1);
  if (markerCount !== expectedMarkerCount) {
    throw new Error(`${evidence.stage} ${evidence.status} requires ${expectedMarkerCount} earned markers`);
  }
  if (evidence.stage === 'NATIVE_CORE_FLOW' && evidence.status !== 'PASS') {
    throw new Error('NATIVE_CORE_FLOW progress must be PASS');
  }

  const signature = `${evidence.stage}:${evidence.status}:${evidence.markers.join('|')}`;
  if (seen.has(signature)) throw new Error('Duplicate Gate 4 progress evidence');
  if (!previous) {
    if (stageIndex !== 0 || evidence.status !== 'RUNNING') {
      throw new Error('Gate 4 progress must begin with APPLICATION_READY RUNNING');
    }
    return { stageIndex, markerCount, status: evidence.status, signature };
  }
  if (previous.status === 'FAIL') throw new Error('Gate 4 progress cannot continue after a failed stage');
  if (stageIndex < previous.stageIndex) throw new Error('Gate 4 progress cannot move backwards');
  if (stageIndex > previous.stageIndex + 1) throw new Error('Gate 4 progress cannot skip stages');
  if (markerCount < previous.markerCount) throw new Error('Gate 4 markers cannot be removed');

  if (stageIndex === previous.stageIndex) {
    if (previous.status !== 'RUNNING' || evidence.status === 'RUNNING') {
      throw new Error('Gate 4 stage progress must move from RUNNING to PASS or FAIL');
    }
  } else {
    if (previous.status !== 'PASS') throw new Error('Gate 4 cannot enter a new stage before the prior stage passes');
    const isTerminalCorePass = evidence.stage === 'NATIVE_CORE_FLOW' && evidence.status === 'PASS';
    if (evidence.status !== 'RUNNING' && !isTerminalCorePass) {
      throw new Error('A new Gate 4 stage must begin in RUNNING state');
    }
  }
  return { stageIndex, markerCount, status: evidence.status, signature };
}

async function readJsonRequest(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('Evidence payload is too large');
  }
  return JSON.parse(raw);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (_) {
    return false;
  }
}

async function writeExclusive(path, body) {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
  } finally {
    await file.close();
  }
}

export async function serveGate4Reporter(outputDir, port, expectedRunId) {
  if (!expectedRunId) throw new Error('Gate 4 reporter runId is required');
  await mkdir(outputDir, { recursive: true });
  const terminalPlatforms = new Set();
  const progressStates = new Map();
  const progressSignatures = new Map();
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, runId: expectedRunId });
    if (req.method !== 'POST' || !['/progress', '/report'].includes(req.url || '')) {
      return json(res, 404, { error: 'Not found' });
    }

    try {
      const evidence = await readJsonRequest(req);
      const terminal = req.url === '/report';
      validateEvidence(evidence, expectedRunId, terminal);
      const terminalPath = resolve(outputDir, `${evidence.platform}-result.json`);
      if (!terminal && (terminalPlatforms.has(evidence.platform) || await exists(terminalPath))) {
        return json(res, 409, { error: 'Terminal Gate 4 report already exists' });
      }
      if (terminal) {
        if (terminalPlatforms.has(evidence.platform)) {
          return json(res, 409, { error: 'Terminal Gate 4 report already exists' });
        }
        const previous = progressStates.get(evidence.platform);
        const terminalStageIndex = GATE4_STAGES.indexOf(evidence.stage);
        if (previous && terminalStageIndex < previous.stageIndex) {
          throw new Error('Terminal Gate 4 evidence cannot move backwards');
        }
        if (previous && evidence.markers.length < previous.markerCount) {
          throw new Error('Terminal Gate 4 evidence cannot remove earned markers');
        }
        if (
          evidence.status === 'PASS'
          && (!previous
            || previous.stageIndex !== GATE4_STAGES.length - 1
            || previous.status !== 'PASS'
            || previous.markerCount !== GATE4_CORE_MARKERS.length)
        ) {
          throw new Error('Gate 4 PASS requires the complete progressive evidence sequence');
        }
        terminalPlatforms.add(evidence.platform);
        try {
          await writeExclusive(terminalPath, evidence);
        } catch (error) {
          if (error?.code === 'EEXIST') return json(res, 409, { error: 'Terminal Gate 4 report already exists' });
          terminalPlatforms.delete(evidence.platform);
          throw error;
        }
      } else {
        const seen = progressSignatures.get(evidence.platform) || new Set();
        const next = validateProgressTransition(evidence, progressStates.get(evidence.platform), seen);
        await appendFile(
          resolve(outputDir, `${evidence.platform}-progress.jsonl`),
          `${JSON.stringify(evidence)}\n`,
          'utf8',
        );
        seen.add(next.signature);
        progressSignatures.set(evidence.platform, seen);
        progressStates.set(evidence.platform, next);
      }
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Invalid evidence' });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '0.0.0.0', () => resolveListen());
  });
  process.stdout.write(`Gate 4 reporter listening on ${server.address().port} for ${expectedRunId}\n`);
  return server;
}

export async function waitForReport(filePath, expectedPlatform, expectedRunId, timeoutMs) {
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
      validateGate4Report(report, expectedPlatform, expectedRunId);
      for (const marker of report.markers) process.stdout.write(`${marker}\n`);
      process.stdout.write(`GATE4_NATIVE_PLATFORM=${expectedPlatform}\n`);
      process.stdout.write(`GATE4_RUN_ID=${expectedRunId}\n`);
      return report;
    } catch (error) {
      lastError = error;
      // Terminal reports are immutable. A parsed invalid report cannot become
      // valid later, so waiting would only waste runner time.
      throw error;
    }
  }
  throw lastError || new Error(`Timed out waiting for ${expectedPlatform} Gate 4 report`);
}

async function main() {
  const [command, first, second, third, fourth] = process.argv.slice(2);
  if (command === 'serve') {
    await serveGate4Reporter(resolve(first), Number(second || 3904), third);
  } else if (command === 'wait') {
    await waitForReport(resolve(first), second, third, Number(fourth || 120_000));
  } else {
    throw new Error(
      'Usage: gate4-reporter.mjs serve <output-dir> [port] <run-id> | '
      + 'wait <report-file> <platform> <run-id> [timeout-ms]',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
