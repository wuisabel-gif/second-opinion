import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InputError, reviewSchema } from './validation.mjs';
import { validateAuthJson } from './crypto.mjs';

const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'hooks',
  'memories',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'image_generation',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'multi_agent',
  'multi_agent_v2',
  'standalone_web_search',
  'web_search_cached',
  'web_search_request',
  'view_image',
  'tool_suggest',
];

export class ConcurrencyGate {
  constructor(limit, maxQueue) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
    this.closed = false;
    this.idleWaiters = [];
  }

  async acquire() {
    if (this.closed) throw new InputError('broker is shutting down', 503, 'unavailable');
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    if (this.queue.length >= this.maxQueue) {
      throw new InputError('broker review queue is full', 503, 'queue_full');
    }
    return new Promise((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next.resolve(() => this.release());
    } else {
      this.active = Math.max(0, this.active - 1);
      this.notifyIdle();
    }
  }

  close() {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(new InputError('broker is shutting down', 503, 'unavailable'));
    }
    this.notifyIdle();
  }

  waitForIdle() {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  notifyIdle() {
    if (this.active !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

function codexArgs(config, model, workspace, schemaPath, outputPath) {
  const args = ['--strict-config'];
  for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
  args.push(
    '--ask-for-approval',
    'never',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    workspace,
    '--model',
    model,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '-',
  );
  return args;
}

async function readBoundedFile(file, maxBytes, label) {
  const metadata = await stat(file);
  if (metadata.size > maxBytes) throw new Error(`${label} exceeded its size limit`);
  return readFile(file);
}

function restrictedEnvironment(root, codexHome, tempDir) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    CODEX_HOME: codexHome,
    TMPDIR: tempDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    RUST_BACKTRACE: '0',
  };
  for (const name of [
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CODEX_CA_CERTIFICATE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function signalProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when no process group exists.
    }
  }
  child.kill(signal);
}

async function executeChild(child, prompt, timeoutMs, maxStreamBytes, abortSignal) {
  let streamBytes = 0;
  let terminationReason = null;
  let killTimer;
  const terminate = (reason) => {
    terminationReason ||= reason;
    signalProcessTree(child, 'SIGTERM');
    killTimer ||= setTimeout(() => signalProcessTree(child, 'SIGKILL'), 2000);
    killTimer.unref();
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      streamBytes += chunk.length;
      if (streamBytes > maxStreamBytes) terminate('overflow');
    });
  }
  child.stdin.on('error', () => terminate('stdin'));

  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(prompt);

  const timer = setTimeout(() => terminate('timeout'), timeoutMs);
  timer.unref();
  const abort = () => terminate('cancelled');
  abortSignal?.addEventListener('abort', abort, { once: true });
  if (abortSignal?.aborted) abort();
  try {
    const status = await result;
    if (terminationReason === 'timeout') throw new Error('Codex review timed out');
    if (terminationReason === 'overflow') throw new Error('Codex process output exceeded its size limit');
    if (terminationReason === 'cancelled') throw new Error('Codex review was cancelled');
    if (terminationReason === 'stdin') throw new Error('Codex stopped before reading the review prompt');
    if (status.code !== 0) throw new Error(`Codex exited unsuccessfully (${status.code ?? status.signal ?? 'unknown'})`);
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    abortSignal?.removeEventListener('abort', abort);
  }
}

export async function runCodex({ authJson, prompt, model, config, signal }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'second-opinion-broker-'));
  const codexHome = path.join(root, 'codex-home');
  const workspace = path.join(root, 'workspace');
  const tempDir = path.join(root, 'tmp');
  const authPath = path.join(codexHome, 'auth.json');
  const schemaPath = path.join(root, 'review-schema.json');
  const outputPath = path.join(root, 'review-output.json');
  let refreshedAuth = null;
  let output = null;
  let executionError = null;

  try {
    await Promise.all([
      mkdir(codexHome, { mode: 0o700 }),
      mkdir(workspace, { mode: 0o700 }),
      mkdir(tempDir, { mode: 0o700 }),
    ]);
    await writeFile(authPath, validateAuthJson(authJson), { mode: 0o600, flag: 'wx' });
    await writeFile(schemaPath, JSON.stringify(reviewSchema(config)), { mode: 0o600, flag: 'wx' });

    const child = spawn(
      config.codexBin,
      codexArgs(config, model, workspace, schemaPath, outputPath),
      {
        cwd: workspace,
        env: restrictedEnvironment(root, codexHome, tempDir),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    try {
      await executeChild(child, prompt, config.codexTimeoutMs, config.maxOutputBytes, signal);
      output = await readBoundedFile(outputPath, config.maxOutputBytes, 'Codex review output');
    } catch (error) {
      executionError = error;
    }

    try {
      const candidate = await readBoundedFile(authPath, 1024 * 1024, 'Codex auth file');
      refreshedAuth = validateAuthJson(candidate);
    } catch {
      refreshedAuth = null;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return { output, refreshedAuth, error: executionError };
}

export const codexInternals = { codexArgs, restrictedEnvironment };
