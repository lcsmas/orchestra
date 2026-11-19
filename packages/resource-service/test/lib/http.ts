// A tiny HTTP-over-unix-socket client for the relay tests (the docker CLI, compose and client libraries all speak this).
import http from 'node:http';

export type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };

/** `chunks` are written one by one WITHOUT a content-length (Transfer-Encoding: chunked), like a client library streaming its body. */
export function request(sock: string, method: string, path: string, o: { body?: string | Buffer; chunks?: (string | Buffer)[]; headers?: http.OutgoingHttpHeaders; timeoutMs?: number } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path, headers: o.headers, agent: false, timeout: o.timeoutMs ?? 10_000 }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer to ${method} ${path}`)));
    req.on('error', reject);
    if (o.chunks) for (const c of o.chunks) req.write(c);
    req.end(o.body);
  });
}
