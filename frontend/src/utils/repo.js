// Resolve the upstream's current URL by its stable repository ID.
// Issue forms are prefilled, never submitted by the app.
export async function getRepoUrl() {
  const response = await fetch('https://api.github.com/repositories/1286263515');
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const data = await response.json();
  const url = new URL(data.html_url);
  if (url.origin !== 'https://github.com') throw new Error('Invalid repository URL');
  return url.href.replace(/\/$/, '');
}

export const issueUrl = (repoUrl, { labels = '', title = '', body = '' }) =>
  `${repoUrl}/issues/new?labels=${encodeURIComponent(labels)}`
  + `&title=${encodeURIComponent(title)}`
  + `&body=${encodeURIComponent(body)}`;
