// Issue forms are prefilled, never submitted by the app.
export const REPO_URL = 'https://github.com/batman-2099/manafolio';

export const issueUrl = (repoUrl, { labels = '', title = '', body = '' }) =>
  `${repoUrl}/issues/new?labels=${encodeURIComponent(labels)}`
  + `&title=${encodeURIComponent(title)}`
  + `&body=${encodeURIComponent(body)}`;
