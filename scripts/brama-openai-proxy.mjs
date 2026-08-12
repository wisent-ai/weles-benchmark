#!/usr/bin/env node
import { createServer } from 'node:http';

const host = process.env.BRAMA_PROXY_HOST || '127.0.0.1';
const port = positiveInteger(process.env.BRAMA_PROXY_PORT, 8789);
const upstreamBase = requiredUrl(process.env.BRAMA_UPSTREAM_BASE_URL);
const bodyLimit = 16 * 1024 * 1024;

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || !new URL(request.url || '/', 'http://localhost').pathname.endsWith('/chat/completions')) {
      json(response, 404, { error: { message: 'not_found', type: 'request_error', code: 'not_found' } });
      return;
    }
    const input = await readJson(request);
    const normalized = normalize(input);
    const upstream = await fetch(new URL('chat/completions', trailingSlash(upstreamBase)), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(typeof request.headers.authorization === 'string'
          ? { authorization: request.headers.authorization }
          : {}),
      },
      body: JSON.stringify(normalized),
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'content-length': String(payload.length),
    });
    response.end(payload);
  } catch (error) {
    json(response, 400, {
      error: {
        message: error instanceof Error ? error.message : 'invalid_request',
        type: 'request_error',
        code: 'invalid_request',
      },
    });
  }
});

server.listen(port, host, () => {
  process.stderr.write(`Brama OpenAI request adapter listening on http://${host}:${port}/v1\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object');
  if (!Array.isArray(value.messages)) throw new Error('messages must be an array');
  const maxTokens = value.max_tokens ?? value.max_completion_tokens ?? 4096;
  const result = {
    model: typeof value.model === 'string' && value.model.trim() ? value.model : 'any',
    messages: value.messages,
    max_tokens: positiveInteger(maxTokens, 4096),
  };
  if (typeof value.temperature === 'number' && Number.isFinite(value.temperature)) result.temperature = value.temperature;
  if (Array.isArray(value.tools)) result.tools = value.tools;
  if (value.tool_choice !== undefined) result.tool_choice = value.tool_choice;
  if (value.billingTarget !== undefined) result.billingTarget = value.billingTarget;
  return result;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > bodyLimit) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function requiredUrl(value) {
  if (!value?.trim()) throw new Error('BRAMA_UPSTREAM_BASE_URL is required');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('BRAMA_UPSTREAM_BASE_URL must use HTTP or HTTPS');
  return parsed;
}

function trailingSlash(value) {
  return new URL(value.href.endsWith('/') ? value.href : `${value.href}/`);
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('expected a positive integer');
  return parsed;
}

function json(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length) });
  response.end(payload);
}
