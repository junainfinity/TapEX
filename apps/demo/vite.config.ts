import { defineConfig, type Plugin, type UserConfig } from 'vite';

// Paper demo (default): exactly the configuration it always had.
const paper: UserConfig = {server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:8787',changeOrigin:false}}},build:{sourcemap:true},preview:{host:'127.0.0.1',port:4173,strictPort:true}};

/**
 * Maya-Live (VITE_MAYA_MODE=live): index.html boots src/bootstrap-live.ts and /v1 goes to the $OPEN house
 * (MAYA_HOUSE_URL, default http://127.0.0.1:8790). The DEV ONLY test wallet (VITE_MAYA_TEST_WALLET=1) is a
 * compile-time constant: absent from every production build, and a production build asked for it fails.
 */
function liveEntry(): Plugin {
  return {
    name: 'maya-live-entry',
    transformIndexHtml: {
      // Before Vite resolves the entry script, so the live build bundles bootstrap-live.ts instead of the paper entry.
      order: 'pre',
      handler(html) {
        if (!html.includes('src="/src/bootstrap.ts"')) throw new Error('maya-live-entry: index.html no longer names /src/bootstrap.ts');
        return html
          .replace('src="/src/bootstrap.ts"', 'src="/src/bootstrap-live.ts"')
          .replace('aria-label="Maya paper trading game"', 'aria-label="Maya-Live testnet trading game"')
          .replace(/<title>[^<]*<\/title>/, '<title>Maya-Live · TESTNET · Pick a square. Catch the price.</title>')
          .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="Maya-Live on testnet: tap price squares against the $OPEN house with tOPEN, a test mock of $OPEN with no value.">');
      },
    },
  };
}

export default defineConfig(({ command, mode }) => {
  if (process.env.VITE_MAYA_MODE !== 'live') return paper;
  const testWallet = process.env.VITE_MAYA_TEST_WALLET === '1';
  if (testWallet && command === 'build' && mode === 'production') throw new Error('Refusing to bundle the DEV ONLY test wallet into a production build (unset VITE_MAYA_TEST_WALLET, or build with --mode development for local QA).');
  const house = process.env.MAYA_HOUSE_URL ?? 'http://127.0.0.1:8790';
  const port = Number(process.env.MAYA_GAME_PORT ?? 5173);
  return {
    plugins: [liveEntry()],
    define: { __MAYA_TEST_WALLET__: JSON.stringify(testWallet) },
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/v1': { target: house, changeOrigin: false }, '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
    build: { sourcemap: true },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: { '/v1': { target: house, changeOrigin: false } } },
  };
});
