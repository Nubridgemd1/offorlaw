'use strict';

/**
 * Generate ADMIN_PASSWORD_HASH for the Offor Law site editor.
 *
 * Usage:
 *   node tools/hash-password.js "the-password-you-want"
 *   node tools/hash-password.js              (prompts you to type it)
 *
 * Copy the printed "salt:hash" line into the ADMIN_PASSWORD_HASH env var on Hyperlift.
 * The plaintext password is never stored — only this one-way hash.
 */

const crypto = require('node:crypto');
const readline = require('node:readline');

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return salt + ':' + derived;
}

function output(password) {
  if (!password || String(password).length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  console.log('\nADMIN_PASSWORD_HASH=' + hash(password) + '\n');
  console.log('Also generate a session secret with:');
  console.log("  node -e \"console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))\"\n");
}

const arg = process.argv[2];
if (arg) {
  output(arg);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the password to hash: ', (answer) => { rl.close(); output(answer); });
}
