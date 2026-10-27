import { defineConfig } from 'vite';

// House server for the dev proxy: MAYA_ADMIN_API_TARGET overrides the default MAYA_ADMIN_PORT (8790) on localhost.
const target = process.env['MAYA_ADMIN_API_TARGET'] ?? 'http://127.0.0.1:8790';

export default defineConfig({
  server: {
    host: '127.0.0.1', port: 5180, strictPort: true,
    // /admin-api carries the bearer token; /v1/account/:address/proof is the public escape-hatch proof lookup (no token sent).
    proxy: { '/admin-api': { target, changeOrigin: false }, '/v1/account': { target, changeOrigin: false } },
  },
  build: { sourcemap: true },
  preview: { host: '127.0.0.1', port: 4180, strictPort: true },
});
