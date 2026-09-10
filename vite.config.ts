import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

/** Dev-only: lets tools/georef.html save a corrected transform straight to
 *  data/georef/<CODE>.json. Automatic registration will not hold up for all 62
 *  buildings, and a fix that cannot be saved is not a fix. */
function georefWriter(): Plugin {
  return {
    name: 'georef-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__georef', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end('POST only'); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const d = JSON.parse(body);
            if (!/^[A-Za-z0-9_ -]{1,40}$/.test(d.code)) throw new Error('bad code');
            mkdirSync('data/georef', { recursive: true });
            const p = `data/georef/${d.code}.json`;
            const prev = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
            writeFileSync(p, JSON.stringify({ ...prev, ...d, method: 'manual' }, null, 1));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: p }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({ build: { target: 'es2022' }, plugins: [georefWriter()] });
