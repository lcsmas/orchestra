// Shared browser-rig fixture site (#388 seam, owned by #395). Dependency-free.
// usage: node server.mjs [port|0]  → prints `LISTENING <port>` once bound.
// Routes: pages/*.html at /<name>.html (and / → index.html) · GET /signin sets
// sid · GET /whoami → anon|<sid> · POST /upload (multipart) echoes name + size.
// Other tickets ADD pages/<topic>.html only; never edit this file's contract.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages')

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

// Minimal multipart reader: first file part → { name, size } (bytes of its body).
function parseUpload(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (!m) return null
  const delim = Buffer.from('--' + (m[1] ?? m[2]))
  let at = buf.indexOf(delim)
  while (at !== -1) {
    const next = buf.indexOf(delim, at + delim.length)
    if (next === -1) break
    const part = buf.subarray(at + delim.length, next)
    const split = part.indexOf('\r\n\r\n')
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8')
      const fn = /filename="([^"]*)"/i.exec(head)
      if (fn) return { name: fn[1], size: Math.max(0, part.length - split - 4 - 2) } // minus trailing CRLF
    }
    at = next
  }
  return null
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra })
    res.end(body)
  }
  if (req.method === 'GET' && url.pathname === '/signin') {
    const sid = crypto.randomBytes(8).toString('hex')
    return send(200, 'text/plain; charset=utf-8', `signed-in ${sid}`, {
      'set-cookie': `sid=${sid}; Max-Age=86400; Path=/; SameSite=Lax`,
    })
  }
  if (req.method === 'GET' && url.pathname === '/whoami') {
    return send(200, 'text/plain; charset=utf-8', cookieOf(req, 'sid') ?? 'anon')
  }
  if (req.method === 'POST' && url.pathname === '/upload') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const up = parseUpload(Buffer.concat(chunks), req.headers['content-type'])
      send(up ? 200 : 400, 'application/json', JSON.stringify(up ?? { error: 'no file part' }))
    })
    return
  }
  if (req.method === 'GET') {
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (/^[\w.-]+\.html$/.test(name)) {
      const file = path.join(PAGES, name)
      if (fs.existsSync(file)) return send(200, 'text/html; charset=utf-8', fs.readFileSync(file))
    }
  }
  send(404, 'text/plain; charset=utf-8', 'not found')
})

const want = Number(process.argv[2] ?? 0)
server.listen(Number.isFinite(want) ? want : 0, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`)
})
