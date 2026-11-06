'use strict';

/** Wrap an async route so rejected promises reach errorHandler (Express 4). */
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
