'use strict';

const { AppError, fromPgError } = require('../shared/errors');
const config = require('../config');

/** 404 for unmatched routes. Mount after all routers. */
function notFound(req, res, next) {
  next(new AppError('ROUTE_NOT_FOUND', `Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Final error handler. Every error response has the shape
 *   { "error": { "code", "message", "details" } }
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let appErr = err;

  if (!(appErr instanceof AppError)) appErr = fromPgError(err);

  // Malformed JSON body from express.json()
  if (!(appErr instanceof AppError) && err.type === 'entity.parse.failed') {
    appErr = new AppError('BAD_REQUEST', 'Request body is not valid JSON');
  }

  if (!(appErr instanceof AppError)) {
    console.error('[error]', err);
    appErr = new AppError(
      'INTERNAL_ERROR',
      undefined,
      config.isProd ? null : { reason: err && err.message }
    );
  } else if (appErr.status >= 500) {
    console.error('[error]', err);
  }

  res.status(appErr.status).json({ error: appErr.toJSON() });
}

module.exports = { errorHandler, notFound };
