import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
register(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'resources-stubs-hook.mjs')).href);
