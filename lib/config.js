import { unavailable } from './errors.js';

export function loadConfig(env = process.env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    const origin = new URL(env.APP_ORIGIN);
    const secret = env.SUPABASE_SECRET_KEY;
    const rateSecret = env.RATE_LIMIT_SECRET;
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.pathname !== '/' ||
        origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.origin !== env.APP_ORIGIN || !/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(secret ?? '') ||
        /REPLACE|YOUR_/.test(secret) || !rateSecret || rateSecret.length < 32 ||
        /REPLACE|YOUR_/.test(rateSecret)) throw new Error();
    // Optional after first initialization; validated only against an empty database.
    return { supabaseUrl: url.origin, supabaseKey: secret, origin: origin.origin, rateSecret,
      initialUserPassword: env.INITIAL_USER_PASSWORD };
  } catch { throw unavailable(); }
}
