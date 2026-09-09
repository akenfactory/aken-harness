/** Self-contained, script-free login page: dsh web's only entry point. */

const PAGE_STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; background: #0b0d10; color: #e6e6e6;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #16191d; padding: 2rem; border-radius: 8px; width: 20rem; max-width: 90vw; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-size: 0.85rem; color: #a9adb3; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; border-radius: 4px;
    border: 1px solid #333; background: #0b0d10; color: inherit; }
  button { margin-top: 1.25rem; width: 100%; padding: 0.6rem; border-radius: 4px; border: none;
    background: #3b82f6; color: white; font-weight: 600; cursor: pointer; }
  p.error { color: #f87171; margin: 0.75rem 0 0; font-size: 0.85rem; }
`

/**
 * Render the admin login page: a plain `<form method="POST">`, deliberately
 * with no `<script>` — the SPA/plugin graph must never load before
 * authentication succeeds, and a scriptless form needs no fetch/CORS handling.
 * @param options - whether to show the "invalid credentials" notice.
 * @returns the full HTML document.
 */
export function renderLoginPage(options: { readonly invalid?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>dsh web sign-in</title><style>${PAGE_STYLE}</style></head>
<body>
  <form method="POST" action="/login">
    <h1>Sign in to dsh web</h1>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    ${options.invalid === true ? '<p class="error">Invalid email or password.</p>' : ''}
  </form>
</body>
</html>
`
}

/**
 * Parse an `application/x-www-form-urlencoded` login submission.
 * @param raw - the raw request body.
 * @returns the submitted email/password, or undefined when either is missing.
 */
export function parseLoginBody(raw: string): { readonly email: string; readonly password: string } | undefined {
  const params = new URLSearchParams(raw)
  const email = params.get('email')
  const password = params.get('password')
  if (email === null || password === null) return undefined
  return { email, password }
}
