const [major, minor, patch] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && (minor > 12 || (minor === 12 && patch >= 0)));

if (!supported) {
  console.error(
    `EasySplit mobile tooling requires Node 22.12.0 or newer (current: ${process.versions.node}). ` +
    'The existing web runtime is not changed by this check; switch Node only for mobile commands.',
  );
  process.exit(1);
}

console.log(`EasySplit mobile Node check passed (${process.versions.node}).`);
