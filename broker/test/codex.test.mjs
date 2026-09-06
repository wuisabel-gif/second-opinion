import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConcurrencyGate, codexInternals, runCodex } from '../src/codex.mjs';
import { InputError } from '../src/validation.mjs';
import { sampleAuthJson, testConfig } from '../test-support/helpers.mjs';

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

test('restricted environment carries no provider or host secrets', () => {
  const env = codexInternals.restrictedEnvironment('/root', '/root/codex-home', '/root/tmp');
  assert.equal(env.HOME, '/root');
  assert.equal(env.CODEX_HOME, '/root/codex-home');
  assert.equal(env.TMPDIR, '/root/tmp');
  for (const leaked of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'BROKER_MASTER_KEY', 'GITHUB_TOKEN']) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the Codex process`);
  }
  for (const required of ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'RUST_BACKTRACE', 'TMPDIR']) {
    assert.ok(required in env);
  }
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
  let idle = false;
  const drained = gate.waitForIdle().then(() => { idle = true; });
  await assert.rejects(waiting, /shutting down/);
  await assert.rejects(() => gate.acquire(), /shutting down/);
  assert.equal(idle, false);
  release();
  await drained;
  assert.equal(idle, true);
});

test('broker cancellation kills the Codex process group and preserves refreshed auth', async (t) => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'second-opinion-codex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'fake-codex.sh');
  await writeFile(executable, '#!/bin/sh\ntrap "" TERM\nsleep 30\n');
  await chmod(executable, 0o700);
  const config = testConfig({ CODEX_BIN: executable, BROKER_CODEX_TIMEOUT_MS: '300000' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20).unref();
  const result = await runCodex({
    authJson: sampleAuthJson(),
    prompt: 'test',
    model: 'gpt-5.6-sol',
    config,
    signal: controller.signal,
  });
  assert.match(result.error.message, /cancelled/);
  assert.ok(result.refreshedAuth);
  result.refreshedAuth.fill(0);
});

test('early Codex exit cannot crash the broker with an unhandled stdin EPIPE', async (t) => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'second-opinion-codex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'exit-immediately.sh');
  await writeFile(executable, '#!/bin/sh\nexit 2\n');
  await chmod(executable, 0o700);
  const config = testConfig({ CODEX_BIN: executable, BROKER_CODEX_TIMEOUT_MS: '300000' });
  const result = await runCodex({
    authJson: sampleAuthJson(),
    prompt: 'x'.repeat(1024 * 1024),
    model: 'gpt-5.6-sol',
    config,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /Codex/);
  result.refreshedAuth?.fill(0);
});
