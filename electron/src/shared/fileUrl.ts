/** file:// URL for an absolute POSIX path. Each segment is percent-encoded,
 *  so spaces, `#` and `?` in folder names survive. */
export function fileUrl(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}
