import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { noteArtChanged, useCardArtIndex } from './cardArt';

// Run on an isolated Vite page so the page-load art index starts here.
export async function runCardArtRegressions() {
  const original = { fetch: window.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let resolveIndex;
  let current;
  function Probe() { current = useCardArtIndex(); return null; }
  window.fetch = url => {
    if (url !== '/api/card-art/index') throw new Error(`Unexpected request: ${url}`);
    return new Promise(resolve => { resolveIndex = resolve; });
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => {
      noteArtChanged('local-upload', true);
      noteArtChanged('local-delete', false);
    });
    await act(async () => resolveIndex({ ok: true, json: async () => ({ ids: ['server-art', 'local-delete'] }) }));
    if (!current.has('local-upload') || current.has('local-delete') || !current.has('server-art')) {
      throw new Error('Late initial art index must retain local uploads and deletions while loading untouched server art');
    }
    return { passed: ['deferred-art-index-local-upload-and-delete'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = original.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
  }
}
