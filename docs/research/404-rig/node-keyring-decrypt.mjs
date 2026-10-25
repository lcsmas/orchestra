// #404 rig — arm C secrets: PLAIN NODE decrypts an Electron safeStorage blob with no Electron at all.
// Reimplements Chromium's Linux OSCrypt (components/os_crypt/sync/os_crypt_linux.cc):
//   v11 = AES-128-CBC, key = PBKDF2-HMAC-SHA1(<keyring password>, "saltysalt", 1 iter, 16 B), IV = 16 spaces
//   v10 = same, password hard-coded "peanuts" (the basic_text backend — no keyring involved)
// The v11 password is the libsecret item {schema chrome_libsecret_os_crypt_password_v2,
// application=<app name>}, read here with `secret-tool` (libsecret's CLI, no npm binding).
//
//   node node-keyring-decrypt.mjs <blob-file> <app-name> [--password-override <pw>]
// Prints one line `R404 {json}`.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const [blobFile, appName, flag, override] = process.argv.slice(2);
const out = { arm: 'system-node-keyring', node: process.versions.node };
try {
  const blob = Buffer.from(fs.readFileSync(blobFile, 'utf8'), 'base64');
  const prefix = blob.subarray(0, 3).toString('latin1');
  out.prefix = prefix;
  let password;
  if (flag === '--password-override') {
    password = override;
    out.passwordSource = 'override';
  } else if (prefix === 'v10') {
    password = 'peanuts';
    out.passwordSource = 'hardcoded-v10';
  } else {
    password = execFileSync('secret-tool', ['lookup', 'application', appName], { encoding: 'utf8' });
    out.passwordSource = 'secret-tool';
  }
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  out.plain = Buffer.concat([d.update(blob.subarray(3)), d.final()]).toString('utf8');
} catch (e) {
  out.err = String(e.message).split('\n')[0].slice(0, 200);
}
process.stdout.write('R404 ' + JSON.stringify(out) + '\n');
