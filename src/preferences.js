// Pure JavaScript shared by the CLI and Claude's mod runtime.
function absolutePath(path, cwd) {
  const normalized = [];
  for (const part of (path.startsWith('/') ? path : cwd + '/' + path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return '/' + normalized.join('/');
}

const styleCache = new Map();

export async function readGlazes(cwd, files, { provider, home, configHome } = {}) {
  const directory = absolutePath(cwd, '/');
  const paths = [];
  if (home) paths.push(absolutePath(home + '/.agents/GLAZES.md', directory));
  const providerHome = configHome || (home && ['claude', 'codex'].includes(provider) && home + '/.' + provider);
  if (providerHome) paths.push(absolutePath(providerHome + '/GLAZES.md', directory));
  const ancestors = [];
  for (let path = directory;; path = path.slice(0, path.lastIndexOf('/')) || '/') {
    ancestors.unshift((path === '/' ? '' : path) + '/GLAZES.md');
    if (path === '/') break;
  }
  paths.push(...ancestors);
  const styles = [];
  try {
    // A default can also be an ancestor; keep its most-local position.
    for (const path of paths.filter((path, index) => paths.lastIndexOf(path) === index)) {
      try {
        if (!await files.exists(path)) { styleCache.delete(path); continue; }
        const info = await files.stat(path, { resolve: true });
        if (info.kind !== 'file') throw new Error('GLAZES.md must resolve to a regular file.');
        // Claude exposes size, mtimeMs, and the resolved symlink path. Node also
        // supplies identity and change metadata to detect replacements and chmod.
        const version = Number.isFinite(info.size) && Number.isFinite(info.mtimeMs)
          ? JSON.stringify([info.size, info.mtimeMs, info.realPath, info.isLink, info.ctimeMs, info.dev, info.ino, info.mode])
          : undefined;
        const cached = styleCache.get(path);
        const style = version !== undefined && cached?.version === version
          ? cached.style : await (files.readStyle ?? files.read)(path);
        if (version !== undefined) styleCache.set(path, { version, style });
        else styleCache.delete(path);
        if (style) styles.push(style);
      } catch (error) { styleCache.delete(path); throw error; }
    }
    return styles.join('\n\n');
  } catch { throw new Error('Could not read GLAZES.md.'); }
}

export function rewriteInput(message, requiredTokens, glazes = '') {
  const envelope = JSON.stringify({ message, ...(requiredTokens.length ? { requiredTokens } : {}) });
  return glazes ? glazes + '\n\n' + envelope : envelope;
}
