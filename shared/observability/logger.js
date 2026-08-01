'use strict';

const process = require('node:process');
const { withTraceContext } = require('./trace-context');

const service = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'unknown-service';

function serializeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause
  };
}

function write(level, message, fields = {}) {
  const entry = withTraceContext({
    timestamp: new Date().toISOString(),
    service,
    level,
    message,
    ...fields
  });

  if (entry.error) {
    entry.error = serializeError(entry.error);
  }

  const line = `${JSON.stringify(entry)}\n`;

  if (level === 'error' || level === 'fatal') {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
}

const logger = {
  debug(message, fields) {
    write('debug', message, fields);
  },

  info(message, fields) {
    write('info', message, fields);
  },

  warn(message, fields) {
    write('warn', message, fields);
  },

  error(message, fields) {
    write('error', message, fields);
  }
};

module.exports = {
  logger
};