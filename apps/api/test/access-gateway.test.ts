import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { accessGate, accessToken } from '../src/access.js';
import { accessToken as webAccessToken } from '../../web/src/lib/access.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function call(gate: ReturnType<typeof accessGate>, request: { address: string; headers?: Record<string, string> }) {
  let status = 200;
  let passed = false;
  const req = { socket: { remoteAddress: request.address }, headers: request.headers ?? {} } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  gate(req, res, () => {
    passed = true;
  });
  return passed ? 200 : status;
}

describe('access code', () => {
  const gate = accessGate('ABCD-2345');
  const cookie = `theme=dark; dv_access=${accessToken('abcd2345')}`;

  it('is checked the same way by the API and the web app', () => {
    assert.equal(accessToken('ABCD-2345'), webAccessToken('abcd 2345'));
  });

  it('lets the computer running DocuView call its own API', () => {
    assert.equal(call(gate, { address: '127.0.0.1' }), 200);
    assert.equal(call(gate, { address: '::ffff:127.0.0.1' }), 200);
  });

  it('asks everyone else for the code, including traffic forwarded from loopback', () => {
    assert.equal(call(gate, { address: '192.168.1.20' }), 401);
    // The gateway and the tunnel connect from loopback but say whom they forward.
    assert.equal(call(gate, { address: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } }), 401);
  });

  it('accepts the signed-in cookie and nothing else', () => {
    assert.equal(call(gate, { address: '192.168.1.20', headers: { cookie } }), 200);
    assert.equal(call(gate, { address: '192.168.1.20', headers: { cookie: `dv_access=${accessToken('WRONG999')}` } }), 401);
  });

  it('stays out of the way when there is no code', () => {
    assert.equal(call(accessGate(''), { address: '192.168.1.20' }), 200);
  });
});

describe('gateway', () => {
  it('streams a body past 10 MB to the API whole, and sends pages to the web app', async () => {
    const received: Record<string, number> = {};
    const upstream = (name: string) =>
      http.createServer((req, res) => {
        let bytes = 0;
        req.on('data', (chunk: Buffer) => (bytes += chunk.length));
        req.on('end', () => {
          received[name] = bytes;
          res.end(`${name}:${bytes}:${req.headers['x-forwarded-for'] ? 'forwarded' : 'direct'}`);
        });
      });
    const api = upstream('api').listen(0, '127.0.0.1');
    const web = upstream('web').listen(0, '127.0.0.1');
    await Promise.all([new Promise((r) => api.once('listening', r)), new Promise((r) => web.once('listening', r))]);

    const probe = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => probe.once('listening', r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();

    const gateway = spawn(process.execPath, [path.join(repo, 'scripts', 'gateway.mjs')], {
      env: {
        ...process.env,
        GATEWAY_PORT: String(port),
        GATEWAY_HOST: '127.0.0.1',
        API_PORT: String((api.address() as AddressInfo).port),
        WEB_INTERNAL_PORT: String((web.address() as AddressInfo).port),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((r) => gateway.stdout!.once('data', r));

    try {
      const body = Buffer.alloc(15 * 1024 * 1024, 7);
      const upload = await fetch(`http://127.0.0.1:${port}/api/v1/uploads`, { method: 'POST', body });
      assert.equal(await upload.text(), `api:${body.length}:forwarded`);
      const page = await fetch(`http://127.0.0.1:${port}/viewer`);
      assert.equal(await page.text(), 'web:0:forwarded');
    } finally {
      gateway.kill();
      api.close();
      web.close();
    }
  });
});
