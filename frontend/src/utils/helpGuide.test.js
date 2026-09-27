import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGuide } from './helpGuide.js';

test('retains introductory content, GFM tables, nested lists, list starts, and literal code', () => {
  const chapters = buildGuide(`# Guide

Introductory **advice** with a [reference][readme].

## Contents

- [Use cards](#use-cards)

## Use cards

| Card | Copies |
| --- | ---: |
| Bolt | 4 |

3. Choose a card
   - Check the printing
     - Check the finish
4. Save it

\`<script>alert("code")</script>\`

\`\`\`html
<img src=x onerror=alert(1)>
\`\`\`

[readme]: ../README.md#install
`);
  assert.deepEqual(chapters.map(({ id }) => id), ['howto-overview', 'howto-use-cards']);
  assert.equal(chapters[0].title, 'About this guide');
  assert.match(chapters[0].html, /<h2 id="howto-overview" tabindex="-1">Guide<\/h2>/);
  assert.match(chapters[0].html, /Introductory <strong>advice<\/strong>/);
  assert.match(chapters[0].html, /href="https:\/\/github.com\/batman-2099\/manafolio\/blob\/main\/README.md#install"/);
  const { html, text } = chapters[1];
  assert.match(html, /<table>[\s\S]*<th>Card<\/th>[\s\S]*<td>Bolt<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<ol start="3">[\s\S]*<ul>[\s\S]*<ul>[\s\S]*Check the finish/);
  assert.match(html, /<code>&lt;script&gt;alert\(&quot;code&quot;\)&lt;\/script&gt;<\/code>/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.doesNotMatch(html, /<img\b/);
  assert.match(text, /Card Copies\nBolt 4/);
  assert.match(text, /Check the finish/);
  assert.doesNotMatch(text, /<table>|<strong>|<li>/);
});

test('makes raw HTML and dangerous URLs inert while preserving safe document links', () => {
  const [{ html }] = buildGuide(`# Guide

<script>alert('raw')</script>

<img src=x onerror=alert(1)>

[bad](javascript:alert%281%29) [data](data:text/html,bad) [encoded](javascript&#58;alert%281%29)

![bad image](data:image/svg+xml,bad)

[safe](https://example.com/?x=1&y=2 "A quoted title") [privacy](../PRIVACY.md) [translation](TRANSLATING.md)
`);
  assert.doesNotMatch(html, /<(?:script|img)\b/);
  assert.doesNotMatch(html, /(?:href|src)="(?:javascript|data|vbscript):/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example.com\/\?x=1&amp;y=2" title="A quoted title" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/github.com\/batman-2099\/manafolio\/blob\/main\/PRIVACY.md"/);
  assert.match(html, /href="https:\/\/github.com\/batman-2099\/manafolio\/blob\/main\/docs\/TRANSLATING.md"/);
});

test('resolves fragments to unique focusable headings, including chapter and suffix collisions', () => {
  const chapters = buildGuide(`# Guide

[Intro](#guide) [Overview](#overview) [Second topic](#topic-1) [Named suffix](#topic-1-1) [Last chapter](#topic-2)

## Overview

### Topic

### Topic

### Topic-1

## Topic
`);
  const headings = chapters.flatMap(chapter => chapter.headings);
  const ids = headings.map(heading => heading.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(chapters.map(chapter => chapter.id), ['howto-overview', 'howto-overview-1', 'howto-topic-2']);
  assert.ok(ids.includes('howto-topic-1-1'));
  const html = chapters.map(chapter => chapter.html).join('');
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(ids.includes(target), `fragment ${target} resolves to a guide heading`);
  }
  for (const { id, level } of headings) {
    assert.ok(html.includes(`<h${level} id="${id}" tabindex="-1">`));
  }
});
