import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('inspector edit controls contain saved copy data before effects can run', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const { default: Inspector } = await server.ssrLoadModule('/src/components/CardInspectorModal.jsx');
    assert.equal(renderToStaticMarkup(React.createElement(Inspector, { card: null })), '');
    const html = renderToStaticMarkup(React.createElement(Inspector, {
      startInEdit: true,
      card: {
        entry_id: 42, card_id: 'mtg-sample', game: 'mtg', name: 'Sample card',
        quantity: 4, purchase_price: 5.25, notes: 'Keep this copy note',
        condition: 'Moderately Played', printing: 'Normal', language: 'English',
        list_type: 'collection', types: [], subtypes: [],
      },
    }));
    assert.match(html, /<input(?=[^>]*id="[^"]*-quantity")(?=[^>]*value="4")[^>]*>/);
    assert.match(html, /<input(?=[^>]*id="[^"]*-price")(?=[^>]*value="5\.25")[^>]*>/);
    assert.match(html, /<textarea[^>]*id="inspector-notes"[^>]*>Keep this copy note<\/textarea>/);
    assert.match(html, /<option[^>]*value="Moderately Played"[^>]*selected=""/);
  } finally {
    await server.close();
  }
});
