import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Search, X } from 'lucide-react';
import { useT } from '../utils/i18n';
import { buildGuide } from '../utils/helpGuide';
import guideSource from '../../../docs/USER_GUIDE.md?raw';
import './HowTo.css';

const chapters = buildGuide(guideSource);

export default function HowTo() {
  const { t } = useT();
  const [chapterId, setChapterId] = useState(chapters[0].id);
  const [query, setQuery] = useState('');
  const articleRef = useRef(null);
  const searchRef = useRef(null);
  const focusTarget = useRef(null);
  const chapterIndex = chapters.findIndex(chapter => chapter.id === chapterId);
  const chapter = chapters[chapterIndex];
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const results = searching ? chapters.filter(item => terms.every(term => `${item.title} ${item.text}`.toLocaleLowerCase().includes(term))) : [];

  const focusHeading = (id) => {
    const heading = articleRef.current?.querySelector(`#${CSS.escape(id)}`);
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
  };

  useLayoutEffect(() => {
    if (!searching && focusTarget.current) {
      focusHeading(focusTarget.current);
      focusTarget.current = null;
    }
  }, [chapterId, searching]);

  const openChapter = (id, headingId = id) => {
    if (id === chapterId && !searching) focusHeading(headingId);
    else focusTarget.current = headingId;
    setQuery('');
    setChapterId(id);
  };

  const followGuideLink = (event) => {
    const link = event.target.closest('a[href^="#howto-"]');
    if (!link) return;
    const id = decodeURIComponent(link.hash.slice(1));
    const destination = chapters.find(item => item.headings.some(heading => heading.id === id));
    if (!destination) return;
    event.preventDefault();
    openChapter(destination.id, id);
  };

  const excerpt = (item) => {
    const text = item.text.replace(/\s+/g, ' ').trim();
    const index = text.toLocaleLowerCase().indexOf(terms[0]);
    const start = Math.max(0, index - 60);
    return `${start ? '… ' : ''}${text.slice(start, start + 220)}${text.length > start + 220 ? '…' : ''}`;
  };

  return (
    <div className="howto-page">
      <header className="howto-heading">
        <h1 className="page-title">{t('howto.title')}</h1>
        <p>{t('howto.subtitle')}</p>
      </header>
      <div className="howto-search">
        <label htmlFor="howto-search">{t('howto.search')}</label>
        <div className="howto-search-field">
          <Search size={20} aria-hidden="true" />
          <input ref={searchRef} id="howto-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('howto.searchPlaceholder')} autoComplete="off" />
          {query && <button type="button" className="btn btn-secondary btn-icon-only" aria-label={t('howto.clear')} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={18} aria-hidden="true" /></button>}
        </div>
        <p className="howto-language">{t('howto.englishNotice')}</p>
      </div>
      <div className="howto-layout">
        <nav className="howto-chapters" aria-label={t('howto.chapters')}>
          <h2>{t('howto.chapters')}</h2>
          <button type="button" className="howto-skip" onClick={() => openChapter(chapterId)}>{t('howto.skip')}</button>
          {chapters.map(item => <button type="button" key={item.id} aria-current={!searching && chapterId === item.id ? 'page' : undefined} onClick={() => openChapter(item.id)}><span lang="en">{item.title}</span></button>)}
        </nav>
        <div className="howto-main">
          <div className="howto-mobile-chapters">
            <label htmlFor="howto-chapter">{t('howto.chapters')}</label>
            <select id="howto-chapter" className="select-control" value={chapterId} onChange={event => openChapter(event.target.value)}>
              {chapters.map(item => <option lang="en" key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </div>
          <p className="howto-result-count" role="status">{searching ? t('howto.results', { count: results.length }) : ''}</p>
          {searching ? (
            <section className="howto-results" aria-label={t('howto.search')}>
              {results.length ? results.map(item => <button key={item.id} type="button" onClick={() => openChapter(item.id)}>
                <span className="howto-result-title" lang="en">{item.title}<ArrowRight size={18} aria-hidden="true" /></span>
                <span className="howto-result-excerpt" lang="en">{excerpt(item)}</span>
              </button>) : <div className="howto-empty"><p>{t('howto.empty')}</p><button type="button" className="btn btn-secondary" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>{t('howto.clear')}</button></div>}
            </section>
          ) : (
            <>
              {chapter.headings.length > 1 && <details className="howto-outline" key={chapterId}>
                <summary>{t('howto.onThisPage')}</summary>
                <ul>{chapter.headings.slice(1).map(heading => <li key={heading.id}><button type="button" lang="en" onClick={() => focusHeading(heading.id)}>{heading.title}</button></li>)}</ul>
              </details>}
              <article ref={articleRef} className="howto-article" lang="en" aria-labelledby={chapterId} onClick={followGuideLink} dangerouslySetInnerHTML={{ __html: chapter.html }} />
              <footer className="howto-pagination">
                {chapterIndex > 0 && <button type="button" className="btn btn-secondary" onClick={() => openChapter(chapters[chapterIndex - 1].id)}><ArrowLeft size={16} aria-hidden="true" />{t('howto.previous')}</button>}
                {chapterIndex < chapters.length - 1 && <button type="button" className="btn btn-secondary howto-next" onClick={() => openChapter(chapters[chapterIndex + 1].id)}>{t('howto.next')}<ArrowRight size={16} aria-hidden="true" /></button>}
              </footer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
