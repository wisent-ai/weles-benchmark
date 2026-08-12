import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const BODY_LIMIT = 16 * 1024;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export async function serveFixture(options: { host: string; port: number }): Promise<void> {
  const server = createServer((request, response) => {
    route(request, response).catch(() => {
      if (!response.headersSent) write(response, 500, 'Internal fixture error');
      else response.destroy();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(options.port, options.host, listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP address');
  process.stdout.write(`${JSON.stringify({ schema: 'weles.benchmark.fixture.v1', host: options.host, port: address.port })}\n`);
  const stopped = Promise.withResolvers<void>();
  const shutdown = (): void => {
    server.close(() => stopped.resolve());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await stopped.promise;
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { status: 'ok', schema: 'weles.benchmark.fixture.v1' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/') {
    html(response, 200, page('Weles Benchmark Fixture', '<h1>Weles Benchmark Fixture</h1><nav><a href="/static">Static</a><a href="/navigation">Navigation</a><a href="/form">Form</a><a href="/dynamic">Dynamic</a><a href="/table">Table</a></nav>'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/static') {
    html(response, 200, page('Static content', '<main data-benchmark="static"><h1>Static content</h1><ul><li>alpha</li><li>beta</li><li>gamma</li></ul><p data-checksum="alpha-beta-gamma">Deterministic fixture</p></main>'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/navigation') {
    html(response, 200, page('Navigation', '<main><h1>Record index</h1><a href="/detail?id=record-42" data-record-id="record-42">Open canonical record</a></main>'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/detail' && url.searchParams.get('id') === 'record-42') {
    html(response, 200, page('Record 42', '<main data-record-id="record-42"><h1>Record 42</h1><output name="value">deterministic-detail</output></main>'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/form') {
    html(response, 200, page('Form', '<main><h1>Deterministic form</h1><form method="post" action="/form"><label>Benchmark value <input name="value" autocomplete="off" required></label><button type="submit">Submit</button></form></main>'));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/form') {
    const form = new URLSearchParams(await requestBody(request));
    const value = form.get('value') ?? '';
    html(response, 200, page('Submitted', `<main data-submitted="true"><h1>Submitted</h1><output name="value">${escapeHtml(value)}</output></main>`));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/dynamic') {
    html(response, 200, page('Dynamic render', '<main><h1>Dynamic render</h1><output id="message" aria-live="polite">pending</output><script>setTimeout(() => { document.getElementById("message").textContent = "rendered-after-delay"; document.body.dataset.ready = "true"; }, 500);</script></main>'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/table') {
    const rows = Array.from({ length: 100 }, (_, index) => `<tr><th scope="row">${index + 1}</th><td>value-${String(index + 1).padStart(3, '0')}</td></tr>`).join('');
    html(response, 200, page('Table scan', `<main><h1>Table scan</h1><table data-row-count="100" data-index-checksum="5050"><thead><tr><th>Index</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></main>`));
    return;
  }
  write(response, 404, 'Fixture route not found');
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error('fixture request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;max-width:60rem;margin:3rem auto;padding:0 1rem}nav{display:flex;gap:1rem}table{border-collapse:collapse}th,td{border:1px solid #aaa;padding:.35rem}</style></head><body>${body}</body></html>`;
}

function html(response: ServerResponse, status: number, body: string): void {
  write(response, status, body, 'text/html; charset=utf-8');
}

function json(response: ServerResponse, status: number, body: Record<string, string>): void {
  write(response, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function write(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
