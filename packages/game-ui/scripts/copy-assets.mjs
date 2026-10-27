import { copyFile, mkdir } from 'node:fs/promises';
for(const name of ['styles.css','adaptive.css','motion.css','controls.css','phone.css']) await copyFile(new URL('../src/'+name,import.meta.url),new URL('../dist/'+name,import.meta.url));
// Live ($OPEN testnet) chrome, exported as @maya/game-ui/live; the paper demo never imports it.
await mkdir(new URL('../dist/live/',import.meta.url),{recursive:true});
await copyFile(new URL('../src/live/live.css',import.meta.url),new URL('../dist/live/live.css',import.meta.url));
