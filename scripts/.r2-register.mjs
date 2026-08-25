// Registers the R1/R2 resolution hook. Used as:
//   node --experimental-strip-types --import ./scripts/.r2-register.mjs <harness>
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(path.join(HERE, '.r2-resolve-hook.mjs')).href, pathToFileURL(HERE + '/'));
