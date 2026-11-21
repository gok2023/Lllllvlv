export function jellyfinAuthorization(token: string): string {
  return `MediaBrowser Token="${token.replace(/["\\]/g, "")}"`;
}
