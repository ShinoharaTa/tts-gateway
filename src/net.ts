/**
 * 接続元の許可リスト（CIDR）と、複数アドレスへの listen。
 *
 * - IPv4-mapped IPv6（::ffff:a.b.c.d）は IPv4 として判定する（デュアルスタックの socket が返す形）
 * - listen 先のアドレスがまだ無い（EADDRNOTAVAIL。起動直後の Tailscale など）ときは 5 秒ごとに再試行し、
 *   ほかのアドレスの待ち受けは止めない
 */
import { createServer, type RequestListener, type Server } from 'node:http';

export type Cidr = { family: 4 | 6; bytes: Uint8Array; prefix: number };

const parseV4 = (s: string): Uint8Array | null => {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
};

const parseV6 = (input: string): Uint8Array | null => {
  let s = input.replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // 末尾の IPv4 表記（::ffff:192.0.2.1）は 16bit × 2 にする
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  if (s.includes('.', lastColon)) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    const hex = (a: number, b: number): string => ((a << 8) | b).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const group = (x: string): number[] | null => {
    if (x === '') return [];
    const gs = x.split(':');
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = group(halves[0]!);
  const rest = halves.length === 2 ? group(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length;
  let groups: number[];
  if (halves.length === 2) {
    if (known > 7) return null;
    groups = [...head, ...new Array<number>(8 - known).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
};

const isV4Mapped = (b: Uint8Array): boolean => b.length === 16 && b.subarray(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff;

/** アドレス → { family, bytes }。IPv4-mapped IPv6 は IPv4 にする。解釈できなければ null */
export const parseIp = (s: string): { family: 4 | 6; bytes: Uint8Array } | null => {
  const v4 = parseV4(s);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseV6(s);
  if (!v6) return null;
  if (isV4Mapped(v6)) return { family: 4, bytes: v6.slice(12) };
  return { family: 6, bytes: v6 };
};

/** "192.0.2.0/24" / "::1/128" / "192.0.2.10"（/32 扱い）。不正なら null */
export const parseCidr = (s: string): Cidr | null => {
  const [addr, prefixRaw, extra] = s.trim().split('/');
  if (!addr || extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  // ::ffff:0:0/96 のような v4-mapped の範囲は v4 の範囲に直す
  const v6Mapped = ip.family === 4 && !parseV4(addr);
  const max = ip.family === 4 ? 32 : 128;
  let prefix = max;
  if (prefixRaw !== undefined) {
    if (!/^\d{1,3}$/.test(prefixRaw)) return null;
    prefix = Number(prefixRaw);
    if (v6Mapped) {
      if (prefix < 96 || prefix > 128) return null;
      prefix -= 96;
    } else if (prefix > max) return null;
  }
  return { family: ip.family, bytes: ip.bytes, prefix };
};

export const inCidr = (ip: { family: 4 | 6; bytes: Uint8Array }, cidr: Cidr): boolean => {
  if (ip.family !== cidr.family) return false;
  let bits = cidr.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip.bytes[i]! & mask) !== (cidr.bytes[i]! & mask)) return false;
  }
  return true;
};

/** 接続元が許可リストに入るか。解釈できないアドレスは入らない */
export const isAllowed = (address: string | undefined, cidrs: readonly Cidr[]): boolean => {
  if (!address) return false;
  const ip = parseIp(address);
  return !!ip && cidrs.some(c => inCidr(ip, c));
};

export const RETRY_LISTEN_MS = 5000;

export type Listening = { servers: Server[]; close: () => Promise<void> };

/**
 * hosts のそれぞれに同じ handler で listen する。EADDRNOTAVAIL は 5 秒ごとに再試行（その間も起動は続ける）。
 * ほかのエラー（EADDRINUSE など）は reject（作った server は閉じる）
 */
export const listenAll = async (
  handler: RequestListener,
  hosts: readonly string[],
  port: number,
  log: (msg: string) => void = console.error,
): Promise<Listening> => {
  const servers: Server[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;
  const close = async (): Promise<void> => {
    closed = true;
    for (const t of timers) clearTimeout(t);
    await Promise.all(
      servers.map(
        s =>
          new Promise<void>(resolve => {
            if (!s.listening) return resolve();
            s.close(() => resolve());
            s.closeAllConnections();
          }),
      ),
    );
  };
  try {
    await Promise.all(
      hosts.map(
        host =>
          new Promise<void>((resolve, reject) => {
            const server = createServer(handler);
            servers.push(server);
            let first = true;
            const attempt = (): void => {
              if (closed) return;
              const onError = (e: NodeJS.ErrnoException): void => {
                server.off('listening', onListening);
                if (e.code === 'EADDRNOTAVAIL') {
                  if (first) log(`listen ${host}:${port}: address not available yet, retrying every ${RETRY_LISTEN_MS / 1000}s`);
                  first = false;
                  const t = setTimeout(() => {
                    timers.delete(t);
                    attempt();
                  }, RETRY_LISTEN_MS);
                  timers.add(t);
                  resolve();
                } else reject(e);
              };
              const onListening = (): void => {
                server.off('error', onError);
                log(`listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`);
                resolve();
              };
              server.once('error', onError);
              server.once('listening', onListening);
              server.listen(port, host);
            };
            attempt();
          }),
      ),
    );
  } catch (e) {
    await close();
    throw e;
  }
  return { servers, close };
};
