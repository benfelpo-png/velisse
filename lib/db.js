/**
 * Database access — one async `sql` template tag.
 * Production: Neon serverless driver over HTTP (DATABASE_URL, injected by the
 * Vercel Neon integration). Tests: plain Postgres via `pg` when TEST_PG_URL is
 * set, so the exact same queries run against a local database in CI.
 */
let _impl = null;

async function impl() {
  if (_impl) return _impl;
  const testUrl = process.env.TEST_PG_URL;
  if (testUrl) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: testUrl });
    _impl = async (strings, vals) => {
      let text = "";
      strings.forEach((s, i) => { text += s; if (i < vals.length) text += "$" + (i + 1); });
      return (await pool.query(text, vals)).rows;
    };
  } else {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url)
      throw new Error("DATABASE_URL is not set — add the Neon integration in Vercel → Storage");
    const { neon } = await import("@neondatabase/serverless");
    const n = neon(url);
    _impl = (strings, vals) => n(strings, ...vals);
  }
  return _impl;
}

export async function sql(strings, ...vals) {
  return (await impl())(strings, vals);
}
