export function cardThumbnailUrl(url) {
  return url?.replace(/^(https:\/\/cards\.scryfall\.io)\/normal\//, '$1/small/');
}
