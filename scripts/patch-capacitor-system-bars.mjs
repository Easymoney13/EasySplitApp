import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_BARS_PATH = resolve(
  scriptDirectory,
  '../node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java',
);

const UNPATCHED_SCRIPT = `                    try {
                      document.documentElement.style.setProperty("--safe-area-inset-top", "%dpx");
                      document.documentElement.style.setProperty("--safe-area-inset-right", "%dpx");
                      document.documentElement.style.setProperty("--safe-area-inset-bottom", "%dpx");
                      document.documentElement.style.setProperty("--safe-area-inset-left", "%dpx");
                    } catch(e) { console.error('Error injecting safe area CSS:', e); }`;

const PATCHED_SCRIPT = `                    try {
                      if (document.documentElement) {
                        document.documentElement.style.setProperty("--safe-area-inset-top", "%dpx");
                        document.documentElement.style.setProperty("--safe-area-inset-right", "%dpx");
                        document.documentElement.style.setProperty("--safe-area-inset-bottom", "%dpx");
                        document.documentElement.style.setProperty("--safe-area-inset-left", "%dpx");
                      }
                    } catch(e) { console.error('Error injecting safe area CSS:', e); }`;

export function patchCapacitorSystemBars(filePath = DEFAULT_SYSTEM_BARS_PATH) {
  const source = readFileSync(filePath, 'utf8');
  const unpatchedCount = source.split(UNPATCHED_SCRIPT).length - 1;
  const patchedCount = source.split(PATCHED_SCRIPT).length - 1;

  if (patchedCount === 1 && unpatchedCount === 0) return 'already-patched';
  if (unpatchedCount !== 1 || patchedCount !== 0) {
    throw new Error(
      `Unsupported @capacitor/android SystemBars source at ${filePath}; refusing to apply a partial patch`,
    );
  }

  const patchedSource = source.replace(UNPATCHED_SCRIPT, PATCHED_SCRIPT);
  if (patchedSource.split(PATCHED_SCRIPT).length - 1 !== 1 || patchedSource.includes(UNPATCHED_SCRIPT)) {
    throw new Error(`Failed to verify the @capacitor/android SystemBars patch at ${filePath}`);
  }
  writeFileSync(filePath, patchedSource);
  return 'patched';
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = patchCapacitorSystemBars();
  console.log(`Capacitor SystemBars safe-area guard: ${result}`);
}
