// Shared path-normalization helpers used by the user and role stores.

// Normalize one folder string to "/a/b" form (forward slashes, leading slash,
// no trailing slash). The share root collapses to "/".
export function normRoot(folder) {
  let p = String(folder || '').replace(/\\/g, '/').trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+/g, '/').replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

// Canonicalize a list of folders: normalize, de-duplicate, sort.
// If any entry is "/" (the whole share), collapse to ["/"] (full access).
export function normFolders(folders) {
  if (!Array.isArray(folders)) return [];
  const norm = folders.map(normRoot);
  if (norm.includes('/')) return ['/'];
  return [...new Set(norm)].sort();
}
