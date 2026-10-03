import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Only the dedicated read-only entry and its dependencies are downloaded, not
// scanner models, artwork, or the authenticated application's editing screens.
export function offlineBuild() {
  return {
    name: 'offline-shell',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const entry = Object.values(bundle).find(item => item.type === 'chunk'
          && item.isEntry && item.facadeModuleId?.endsWith('/offline.html'));
        if (!entry || !bundle['offline.html']) this.error('Offline entry missing from build');
        const paths = new Set(['offline.html']);
        const visit = file => {
          if (paths.has(file)) return;
          paths.add(file);
          const chunk = bundle[file];
          if (chunk?.type !== 'chunk') return;
          for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
          for (const css of chunk.viteMetadata?.importedCss || []) paths.add(css);
        };
        visit(entry.fileName);
        const files = [...paths].sort();
        const hash = createHash('sha256');
        for (const file of files) hash.update(file).update(bundle[file]?.code || bundle[file]?.source || '');
        const template = readFileSync(new URL('../src/offlineServiceWorker.js', import.meta.url), 'utf8');
        // Replace identifiers, not their eslint global declaration.
        const source = template.replace('const ASSETS = __OFFLINE_ASSETS__;', `const ASSETS = ${JSON.stringify(files.map(file => `/${file}`))};`)
          .replace('const CACHE = __OFFLINE_CACHE__;', `const CACHE = ${JSON.stringify(`manafolio-offline-shell-${hash.digest('hex').slice(0, 16)}`)};`);
        this.emitFile({ type: 'asset', fileName: 'offline-worker.js', source });
      },
    },
  };
}
