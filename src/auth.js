import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const COOKIE = 'concordance_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
};

const b64 = (buf) => Buffer.from(buf).toString('base64url');

// Hash both sides before comparing so a length difference cannot leak through
// the comparison itself.
function constantTimeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function checkPassword(given) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) throw new Error('APP_PASSWORD is not set');
  return constantTimeEqual(given ?? '', expected);
}

// One shared password today, so a session carries no identity beyond "signed
// in". When real accounts land, this payload grows a user id and every caller
// below keeps working.
export function issueSession() {
  const payload = b64(JSON.stringify({ exp: Date.now() + TTL_MS, jti: b64(randomBytes(9)) }));
  const mac = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function readSession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.', 2);
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  if (!constantTimeEqual(mac, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: TTL_MS / 1000,
    // The app may sit behind a proxy terminating TLS, so trust the forwarded
    // protocol rather than the socket.
    secure: (req.headers['x-forwarded-proto'] ?? req.protocol) === 'https',
  };
}

export function requireSession(req, reply, done) {
  if (readSession(req.cookies?.[COOKIE])) return done();
  reply.code(401).send({ error: 'not signed in' });
}
