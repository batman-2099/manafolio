import { Marked, Renderer } from 'marked';

const guideUrl = 'https://github.com/batman-2099/manafolio/blob/main/docs/USER_GUIDE.md';
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const slug = title => title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');

function textOf(token) {
  if (token.type === 'html' || token.type === 'def') return '';
  if (token.type === 'list') return token.items.map(textOf).join('\n');
  if (token.type === 'table') return [token.header, ...token.rows].map(row => row.map(textOf).join(' ')).join('\n');
  if (token.tokens) return token.tokens.map(textOf).join(['blockquote', 'list_item'].includes(token.type) ? '\n' : '');
  return token.text || (token.type === 'br' ? '\n' : '');
}

function uniqueSlug(base, used) {
  let result = base;
  for (let index = 1; used.has(result); index++) result = `${base}-${index}`;
  used.add(result);
  return result;
}

export function buildGuide(markdown) {
  const parser = new Marked({ gfm: true });
  const defaultRenderer = new Renderer();
  const tokens = parser.lexer(markdown);
  const chapters = [{ id: 'howto-overview', title: 'About this guide', tokens: [], headings: [] }];
  const sourceSlugs = new Set();
  const ids = new Set(['howto-overview']);
  const anchors = new Map();
  const headingInfo = new Map();
  let chapter = chapters[0];

  for (const token of tokens) {
    if (token.type === 'heading' && token.depth === 2) {
      chapter = textOf(token).trim() === 'Contents' ? null : { tokens: [], headings: [] };
      if (chapter) chapters.push(chapter);
    }
    if (chapter) chapter.tokens.push(token);
    // Assign source slugs even in Contents, matching the document's fragment names.
    parser.walkTokens([token], heading => {
      if (heading.type !== 'heading') return;
      const title = textOf(heading);
      const sourceId = uniqueSlug(slug(title), sourceSlugs);
      if (!chapter) return;
      const isOverview = chapter === chapters[0] && heading.depth === 1 && chapter.headings.length === 0;
      const id = isOverview ? chapter.id : uniqueSlug(`howto-${sourceId}`, ids);
      const info = { id, title, level: Math.max(2, heading.depth) };
      anchors.set(sourceId, id);
      headingInfo.set(heading, info);
      chapter.headings.push(info);
      if (!chapter.id) Object.assign(chapter, { id, title });
    });
  }

  function safeUrl(href) {
    if (href.startsWith('#')) {
      let fragment = href.slice(1);
      try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed fragments inert. */ }
      return `#${anchors.get(fragment) || (ids.has(fragment) ? fragment : `howto-${fragment}`)}`;
    }
    try {
      const url = new URL(href, guideUrl);
      return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  parser.use({ renderer: {
    table(token) {
      const label = token.header.map(textOf).join(', ');
      return `<div class="howto-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(label)}">${defaultRenderer.table.call(this, token)}</div>`;
    },
    code(token) {
      return defaultRenderer.code.call(this, token).replace('<pre>', '<pre tabindex="0">');
    },
    html({ text }) { return escapeHtml(text); },
    heading(token) {
      const { id, level } = headingInfo.get(token);
      return `<h${level} id="${escapeHtml(id)}" tabindex="-1">${this.parser.parseInline(token.tokens)}</h${level}>\n`;
    },
    link({ href, title, tokens: inline }) {
      const label = this.parser.parseInline(inline);
      const url = safeUrl(href);
      if (!url) return label;
      const external = url.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"';
      return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ''}${external}>${label}</a>`;
    },
    image({ href, title, text }) {
      const url = safeUrl(href);
      if (!url || !/^https?:/.test(url)) return escapeHtml(text);
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
    },
  } });

  return chapters.map(({ tokens: content, ...result }) => {
    let html = parser.parser(content);
    if (result.id === 'howto-overview' && !result.headings.some(heading => heading.id === result.id)) {
      result.headings.unshift({ id: result.id, title: result.title, level: 2 });
      html = `<h2 id="${result.id}" tabindex="-1">${result.title}</h2>\n${html}`;
    }
    return { ...result, html, text: content.map(textOf).join('\n') };
  });
}
