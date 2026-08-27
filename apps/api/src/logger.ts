import pino from 'pino';
import { config } from './config.js';

/**
 * Technical detail goes here and *only* here. Anything sent to the browser is
 * rewritten into a plain sentence by `toUserError()`.
 */
export const logger = pino(
  config.prettyLogs
    ? {
        level: config.logLevel,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : { level: config.logLevel },
);

export type Logger = typeof logger;
