#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 5 * 1024 * 1024);
const AUTH_TOKEN = nonEmpty(process.env.REVIEW_WEBHOOK_TOKEN);
const AUTH_HEADER = (process.env.REVIEW_AUTH_HEADER || 'Authorization').trim();
const AUTH_SCHEME = (process.env.REVIEW_AUTH_SCHEME || 'Bearer').trim();
const OPENAI_API_KEY = nonEmpty(process.env.OPENAI_API_KEY);
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_MODEL = nonEmpty(process.env.OPENAI_MODEL) || 'gpt-5.6-sol';
const PROFILE_PATH = nonEmpty(process.env.LEARNED_PROFILE_PATH);

function nonEmpty(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : '';
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`request body exceeded ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error('request body was not valid JSON');
    err.statusCode = 400;
    err.cause = error;
    throw err;
  }
}

function normalizeSeverity(value) {
  const severity = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (severity === 'high' || severity === 'medium' || severity === 'low') return severity;
  return 'low';
}

function normalizeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;

  const path = typeof finding.path === 'string' ? finding.path.trim() : '';
  const comment = typeof finding.comment === 'string' ? finding.comment.trim() : '';
  const line = Number(finding.line);

  if (!path || !comment || !Number.isInteger(line) || line <= 0) return null;

  return {
    path,
    line,
    severity: normalizeSeverity(finding.severity),
    comment,
  };
}

function normalizeReview(value) {
  if (typeof value === 'string') {
    try {
      return normalizeReview(JSON.parse(stripCodeFences(value)));
    } catch {
      return {
        summary: value.trim() || 'Review completed.',
        findings: [],
      };
    }
  }

  if (!value || typeof value !== 'object') {
    return {
      summary: 'No valid review payload was produced.',
      findings: [],
    };
  }

  if (value.summary !== undefined && value.findings !== undefined) {
    const findings = Array.isArray(value.findings)
      ? value.findings.map(normalizeFinding).filter(Boolean)
      : [];
    return {
      summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : 'Review completed.',
      findings,
    };
  }

  for (const key of ['review', 'output', 'result', 'data', 'text', 'content']) {
    if (key in value) {
      const nested = normalizeReview(value[key]);
      if (nested) return nested;
    }
  }

  if (value.choices && Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      const content = choice?.message?.content;
      if (typeof content === 'string') return normalizeReview(content);
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string') return normalizeReview(part.text);
          if (typeof part?.content === 'string') return normalizeReview(part.content);
        }
      }
    }
  }

  if (value.output && Array.isArray(value.output)) {
    for (const item of value.output) {
      if (item?.type !== 'message') continue;
      const content = item.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string') return normalizeReview(part.text);
          if (typeof part?.content === 'string') return normalizeReview(part.content);
        }
      }
    }
  }

  return {
    summary: 'Review completed.',
    findings: [],
  };
}

function stripCodeFences(text) {
  return text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

async function loadProfile(repository) {
  if (!PROFILE_PATH || !repository) return null;

  try {
    const raw = await fs.readFile(PROFILE_PATH, 'utf8');
    const all = JSON.parse(raw);
    return all?.[repository] ?? null;
  } catch {
    return null;
  }
}

function buildPrompt(payload, profile) {
  const repository = typeof payload.repository === 'string' ? payload.repository.trim() : '';
  const diff = typeof payload.diff === 'string' ? payload.diff : '';
  const context = typeof payload.context === 'string' ? payload.context : '';
  const rules = typeof payload.rules === 'string' ? payload.rules : '';
  const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : OPENAI_MODEL;
  const system = typeof payload.system === 'string' && payload.system.trim()
    ? payload.system.trim()
    : 'You are a precise pull request code reviewer. Return only a JSON object with summary and findings.';

  const profileText = profile && typeof profile === 'object'
    ? JSON.stringify(profile, null, 2)
    : 'No repository profile available.';

  const user = [
    `Repository: ${repository || '(unknown)'}`,
    '',
    'Repository profile:',
    profileText,
    '',
    'Trusted review rules:',
    rules || '<none>',
    '',
    'Pull request diff:',
    diff || '<empty>',
    '',
    'Repository context:',
    context || '<empty>',
    '',
    'Return only valid JSON with keys summary and findings.',
  ].join('\n');

  return { model, system, user };
}

async function callOpenAI(payload) {
  if (!OPENAI_API_KEY) return null;

  const profile = await loadProfile(typeof payload.repository === 'string' ? payload.repository : '');
  const { model, system, user } = buildPrompt(payload, profile);
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed with ${response.status}: ${text}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return normalizeReview(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === 'string') return normalizeReview(part.text);
      if (typeof part?.content === 'string') return normalizeReview(part.content);
    }
  }
  return normalizeReview(json);
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;

  const headerName = AUTH_HEADER.toLowerCase();
  const headerValue = req.headers[headerName];
  if (typeof headerValue !== 'string') return false;

  if (AUTH_SCHEME.toLowerCase() === 'none') {
    return headerValue.trim() === AUTH_TOKEN;
  }

  const expected = `${AUTH_SCHEME} ${AUTH_TOKEN}`.trim();
  return headerValue.trim() === expected;
}

function buildFallbackReview(payload) {
  const repository = typeof payload.repository === 'string' && payload.repository.trim()
    ? payload.repository.trim()
    : 'this repository';

  return {
    summary: `Webhook fallback mode is active for ${repository}; no model credential was configured.`,
    findings: [],
  };
}

async function handleReview(req, res) {
  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message });
  }

  if (payload.task && payload.task !== 'pull_request_review') {
    return sendJson(res, 400, { error: "unsupported task; expected 'pull_request_review'" });
  }

  try {
    const review = (await callOpenAI(payload)) || buildFallbackReview(payload);
    return sendJson(res, 200, review);
  } catch (error) {
    return sendJson(res, 500, {
      error: 'review generation failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST') {
    return handleReview(req, res);
  }

  return sendText(res, 405, 'Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`Webhook server listening on http://127.0.0.1:${PORT}`);
});
