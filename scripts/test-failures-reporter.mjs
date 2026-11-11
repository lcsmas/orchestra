// `pnpm run test` reporter (#430): prints exactly what node's default reporter prints
// (spec on a TTY, TAP piped — same pick as node) and records each failing leaf test in
// .test-failures.txt (git-ignored; truncated at run start, so a green run leaves it empty).
import { appendFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { spec as Spec, tap } from 'node:test/reporters'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = fileURLToPath(new URL('../.test-failures.txt', import.meta.url))

async function* record(source) {
  writeFileSync(out, '')
  for await (const ev of source) {
    // A parent of a failing subtest also reports fail (`subtestsFailed`) — list leaves only.
    if (ev.type === 'test:fail' && ev.data.details?.error?.failureType !== 'subtestsFailed') {
      const d = ev.data
      const file = d.file ? relative(root, d.file) : '(unknown file)'
      appendFileSync(out, `${file}${d.line ? `:${d.line}` : ''}\t${d.name}\n`)
    }
    yield ev
  }
}

export default async function* reporter(source) {
  const tapped = record(source)
  yield* process.stdout.isTTY ? Readable.from(tapped).compose(new Spec()) : tap(tapped)
}
