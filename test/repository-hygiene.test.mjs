import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedPaths() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function isPlaintextEnvironmentPath(repositoryPath) {
  const segments = repositoryPath.split('/');
  const basename = segments.at(-1) ?? '';
  if (basename === '.env.example') return false;
  return basename === '.env' || basename.startsWith('.env.') || basename === '.dev.vars' || basename.startsWith('.dev.vars.');
}

function isForbiddenTrackedPath(repositoryPath) {
  const segments = repositoryPath.split('/');
  const hasWranglerState = segments.includes('.wrangler');
  const hasDecryptedEnvironment = segments.some(
    (segment, index) => segment === 'env' && segments[index + 1] === 'dec',
  );
  return hasWranglerState || hasDecryptedEnvironment || isPlaintextEnvironmentPath(repositoryPath);
}

function isIgnored(repositoryPath) {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', repositoryPath], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore failed for ${repositoryPath}: ${result.stderr}`);
}

test('the Git index contains no Wrangler account cache or plaintext/decrypted env state', () => {
  const forbidden = trackedPaths().filter(isForbiddenTrackedPath);
  assert.deepEqual(
    forbidden,
    [],
    `forbidden local state is tracked: ${forbidden.join(', ')}`,
  );
});

test('gitignore fails closed for representative local-state paths', () => {
  for (const repositoryPath of [
    '.wrangler/cache/wrangler-account.json',
    '.dev.vars',
    '.env',
    'nested/.env.production',
    'env/dec/prod.env',
    'nested/env/dec/runtime.env',
  ]) {
    assert.equal(isIgnored(repositoryPath), true, `${repositoryPath} must be ignored`);
  }

  assert.equal(isIgnored('.env.example'), false, '.env.example must remain reviewable');
  assert.equal(
    isIgnored('env/enc/prod.env.enc'),
    false,
    'SOPS-encrypted env files must remain eligible for review and version control',
  );
});
