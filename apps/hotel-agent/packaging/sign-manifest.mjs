// Planova's release step (not shipped): signs an agent update manifest with the update key.
//   node packaging/sign-manifest.mjs --version 0.10.2 --package dist/hotella-agent-0.10.2-linux-x64.zip \
//     --url https://updates.hotella.example/agent/hotella-agent-0.10.2-linux-x64.zip --key /run/secrets/update-key.pem
// The key comes from the release pipeline's secret store (OpenBao), never from the repository. The canonical JSON and
// Ed25519 signature are platform-pki's, the same bytes the agent verifies (UpdateManifest.Verify).
import { createHash, createPrivateKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { argv, stdout } from 'node:process';

const require = createRequire(import.meta.url);
const { signCanonical } = require('../../../packages/platform/pki/dist/index.js');

const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 && fallback === undefined) throw new Error(`--${name} is required`);
  return i < 0 ? fallback : argv[i + 1];
};
const pkg = arg('package');
const body = {
  typ: 'hotella.agent-update.v1',
  version: arg('version'),
  package_url: arg('url'),
  sha256: createHash('sha256').update(readFileSync(pkg)).digest('hex'),
  size: statSync(pkg).size,
  channel: arg('channel', 'stable'),
};
const key = createPrivateKey(readFileSync(arg('key')));
stdout.write(`${JSON.stringify({ ...body, signature: signCanonical(body, key) }, null, 2)}\n`);
