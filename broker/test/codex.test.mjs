import test from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyGate, codexInternals } from '../src/codex.mjs';
import { InputError } from '../src/validation.mjs';
import { testConfig } from '../test-support/helpers.mjs';

test('codex CLI arguments lock down tools, sandbox, and config', () => {
  const config = testConfig();
  const args = codexInternals.codexArgs(config, 'gpt-5.6-sol', '/work', '/schema.json', '/out.json');
  const joined = args.join(' ');
  assert.ok(args.includes('--strict-config'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.match(joined, /--ask-for-approval never/);
  assert.match(joined, /--sandbox read-only/);
  assert.match(joined, /--model gpt-5\.6-sol/);
  assert.match(joined, /--output-schema \/schema\.json/);
  assert.match(joined, /--output-last-message \/out\.json/);
  assert.equal(args.at(-1), '-', 'prompt must be read from stdin');
  const disables = args.filter((arg, index) => args[index - 1] === '--disable');
  for (const feature of ['shell_tool', 'unified_exec', 'multi_agent', 'standalone_web_search', 'browser_use', 'plugins']) {
    assert.ok(disables.includes(feature), `expected ${feature} to be disabled`);
  }
});

test('restricted environment carries no provider or host secrets', async (t) => {
  const savedCert = process.env.SSL_CERT_FILE;
  const savedCodexCert = process.env.CODEX_CA_CERTIFICATE;
  delete process.env.SSL_CERT_FILE;
  delete process.env.CODEX_CA_CERTIFICATE;
  t.after(() => {
    if (savedCert !== undefined) process.env.SSL_CERT_FILE = savedCert;
    if (savedCodexCert !== undefined) process.env.CODEX_CA_CERTIFICATE = savedCodexCert;
  });
  const env = codexInternals.restrictedEnvironment('/root', '/root/codex-home', '/root/tmp');
  assert.equal(env.HOME, '/root');
  assert.equal(env.CODEX_HOME, '/root/codex-home');
  assert.equal(env.TMPDIR, '/root/tmp');
  for (const leaked of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'BROKER_MASTER_KEY', 'GITHUB_TOKEN']) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the Codex process`);
  }
  assert.deepEqual(
    Object.keys(env).sort(),
    ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'RUST_BACKTRACE', 'TMPDIR'].sort(),
  );
});

test('concurrency gate admits up to the limit and queues the rest', async () => {
  const gate = new ConcurrencyGate(1, 1);
  const releaseOne = await gate.acquire();
  let secondResolved = false;
  const second = gate.acquire().then((release) => {
    secondResolved = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false, 'second caller must wait while the slot is held');
  releaseOne();
  const releaseTwo = await second;
  assert.equal(secondResolved, true);
  releaseTwo();
});

test('concurrency gate rejects when the queue is full', async () => {
  const gate = new ConcurrencyGate(1, 0);
  await gate.acquire();
  await assert.rejects(() => gate.acquire(), (error) => {
    assert.ok(error instanceof InputError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, 'queue_full');
    return true;
  });
});

test('concurrency gate rejects new work after close', async () => {
  const gate = new ConcurrencyGate(1, 1);
  const release = await gate.acquire();
  const waiting = gate.acquire();
  gate.close();
  await assert.rejects(waiting, /shutting down/);
  await assert.rejects(() => gate.acquire(), /shutting down/);
  release();
});
