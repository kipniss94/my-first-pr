import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './logger.js';
import { api, queue } from './routes/api.js';

export function createServer() {
  const app = express();

  // Behind a reverse proxy in production; needed for correct rate-limit keys.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API only ever serves data and downloads, never a document shell.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"], 'sandbox': [] },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin requests and curl send no Origin header.
        if (!origin || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.api,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      libreOffice: Boolean(config.libreOfficeBin),
      dwgConverter: Boolean(config.dwgConverterCmd),
    });
  });

  app.use('/api/v1', api);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint.', retryable: false } });
  });

  // Final safety net: nothing technical is ever returned to the browser.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled error');
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(500).json({
      error: { code: 'internal_error', message: 'Something went wrong on our side.', retryable: true },
    });
  });

  return { app, queue };
}
