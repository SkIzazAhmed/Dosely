'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AppError, fromPgError } = require('../src/shared/errors');

test('AppError uses default status and message for known codes', () => {
  const e = new AppError('PHONE_LIMIT_REACHED');
  assert.equal(e.status, 409);
  assert.equal(e.code, 'PHONE_LIMIT_REACHED');
  assert.deepEqual(e.toJSON(), {
    code: 'PHONE_LIMIT_REACHED',
    message: 'An owner can have at most 5 phone numbers',
    details: null,
  });
});

test('AppError keeps custom message and details', () => {
  const e = AppError.validation([{ field: 'name', issue: 'required' }], 'Bad patient');
  assert.equal(e.status, 400);
  assert.deepEqual(e.toJSON(), { code: 'VALIDATION_ERROR', message: 'Bad patient', details: [{ field: 'name', issue: 'required' }] });
});

test('fromPgError maps unique violations, using the constraint map', () => {
  const pg = Object.assign(new Error('dup'), { code: '23505', constraint: 'users_email_key' });
  assert.equal(fromPgError(pg).code, 'DUPLICATE');
  assert.equal(fromPgError(pg, { users_email_key: 'EMAIL_TAKEN' }).code, 'EMAIL_TAKEN');
});

test('fromPgError maps the delete guard trigger', () => {
  const pg = Object.assign(new Error('DELETE_NOT_ALLOWED: rows in shops are deactivated'), { code: 'P0001' });
  assert.equal(fromPgError(pg).code, 'DELETE_NOT_ALLOWED');
});

test('fromPgError leaves non-pg errors alone', () => {
  const e = new Error('plain');
  assert.equal(fromPgError(e), e);
});
