import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './processing/pipeline.js';
import { createServer } from './server.js';
import { initStorage, startSweeper } from './storage/store.js';

async function main(): Promise<void> {
  await initStorage();
  const sweeper = startSweeper();
  const { app, queue } = createServer();

  // Drop bookkeeping for jobs whose files the sweeper has already deleted.
  const pruner = setInterval(() => queue.prune(), 60_000);
  pruner.unref();

  // Boot one processing worker up front so the first upload does not pay for
  // interpreter and WebAssembly start-up.
  pool.prewarm();

  const server = app.listen(config.port, config.host, () => {
    logger.info(
      {
        port: config.port,
        dataDir: config.dataDir,
        libreOffice: config.libreOfficeBin ?? 'not found',
        dwgConverter: config.dwgConverterCmd ? 'configured' : 'not configured',
        maxUploadMb: Math.round(config.maxUploadBytes / 1048576),
        retentionMinutes: Math.round(config.retentionSeconds / 60),
      },
      'DocuView API ready',
    );
    if (!config.libreOfficeBin) {
      logger.warn('LibreOffice was not found: DOC, PPT, XLS, ODF and exact page layouts will be unavailable.');
    } else if (config.libreOfficeFilters.length < 3) {
      logger.warn(
        { filters: config.libreOfficeFilters },
        'LibreOffice is installed without all document filters. Install libreoffice-writer, libreoffice-calc and libreoffice-impress.',
      );
    }
  });

  // Long uploads must not be cut off by the default 5s header timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    clearInterval(pruner);
    pool.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
