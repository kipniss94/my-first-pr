#!/usr/bin/env node
/**
 * The front door: one port that serves the whole product.
 *
 *   /api/*        → the API   (127.0.0.1:API_PORT, default 4000)
 *   everything    → the web app (127.0.0.1:WEB_INTERNAL_PORT, default 3001)
 *
 * Why this exists rather than Next.js's own rewrite to the API: Next wraps
 * every request body in a clone capped at 10 MB, and its proxy reads from that
 * clone. Uploads past 10 MB were cut off and hung until a 30-second timeout.
 * Here both directions are plain streams — no size cap, nothing held in
 * memory — which is also how a cloud deployment would front the app with
 * nginx or a load balancer.
 *
 * Environment: GATEWAY_PORT (3000), GATEWAY_HOST (0.0.0.0), API_PORT (4000),
 * WEB_INTERNAL_PORT (3001).
 */

import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT ?? 3000);
const HOST = process.env.GATEWAY_HOST ?? '0.0.0.0';
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 4000) };
const WEB = { host: '127.0.0.1', port: Number(process.env.WEB_INTERNAL_PORT ?? 3001) };

function unavailable(res) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      error: { code: 'upstream_unavailable', message: 'DocuView is starting or restarting. Try again in a moment.', retryable: true },
    }),
  );
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const server = http.createServer((req, res) => {
  const target = req.url?.startsWith('/api/') ? API : WEB;
  const client = req.socket.remoteAddress ?? '';
  const forwardedFor = req.headers['x-forwarded-for'];

  // Lets the launcher find and stop a gateway left behind by an earlier run.
  if (req.url === '/__gateway' && LOOPBACK.has(client) && !forwardedFor) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ gateway: 'docuview', pid: process.pid }));
    return;
  }

  const upstream = http.request(
    {
      ...target,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        // Who is really asking. The API only trusts calls that come straight
        // from this machine without going through here.
        'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${client}` : client,
        'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host ?? '',
        'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http',
      },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );

  upstream.on('error', () => unavailable(res));
  // A visitor who closes the tab mid-upload frees the upstream at once.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

// Large files over a slow phone connection can take a while; the API has its
// own limits on size and processing time.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.listen(PORT, HOST, () => {
  console.log(`DocuView gateway on http://${HOST}:${PORT} → web ${WEB.port}, api ${API.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
