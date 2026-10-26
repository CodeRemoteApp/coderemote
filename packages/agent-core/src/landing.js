// Served at `/` without auth so the tunnel URL can be opened in any browser. The token
// travels in the URL fragment (`/#token=…`), which browsers never send to the server, and
// the page reveals nothing about the machine: it only turns the fragment into an app link.
import { PAIRING_SCHEME } from '@vsremote/protocol';

export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Code Remote</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f5f7; --card: #fff; --text: #1d1d1f; --muted: #6e6e73; --accent: #0071e3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --card: #1c1c1e; --text: #f5f5f7; --muted: #98989d; --accent: #2997ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: var(--bg); color: var(--text); font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border-radius: 20px; padding: 28px 24px; text-align: center; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 20px; }
  a.button, button { display: block; width: 100%; padding: 14px; border-radius: 12px; border: 0; font: inherit; font-weight: 600;
                     text-decoration: none; cursor: pointer; }
  a.button { background: var(--accent); color: #fff; margin-bottom: 10px; }
  button { background: transparent; color: var(--accent); }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <h1>Code Remote</h1>
  <div id="ready" class="hidden">
    <p>Open this machine in the Code Remote app on your iPhone.</p>
    <a id="open" class="button" href="#">Open in Code Remote</a>
    <button id="copy" type="button">Copy pairing link</button>
  </div>
  <p id="missing" class="hidden">This link is missing its access token. Copy the full link printed by <code>coderemote up</code>.</p>
</main>
<script>
  // Pasting the full link into a tab already showing this page (e.g. after the tunnel's sign-in
  // dropped the fragment) only changes the hash and doesn't reload, so re-read it on hashchange.
  function render() {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    document.getElementById('ready').classList.toggle('hidden', !token);
    document.getElementById('missing').classList.toggle('hidden', !!token);
    if (!token) return;
    const link = '${PAIRING_SCHEME}://pair?url=' + encodeURIComponent(location.origin) + '&token=' + encodeURIComponent(token);
    document.getElementById('open').href = link;
    document.getElementById('copy').textContent = 'Copy pairing link';
    document.getElementById('copy').onclick = async (e) => {
      try { await navigator.clipboard.writeText(link); e.target.textContent = 'Copied'; }
      catch { prompt('Pairing link', link); }
    };
  }
  render();
  addEventListener('hashchange', render);
</script>
</body>
</html>
`;
