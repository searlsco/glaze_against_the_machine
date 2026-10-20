// Pure JavaScript shared by the CLI and Claude's isolated mod runtime.
const quotedWindowsPathPattern = /"(?:[A-Za-z]:\\|\\\\)[^"\r\n]*"/g;
const wordAtEnd = /[\p{L}\p{N}_]$/u;
const wordAtStart = /^[\p{L}\p{N}_]/u;

export const bypassRewrite = (prompt) => /^rawdog\b/i.test(prompt.trimStart());

// Recognize complete delimiter runs and explicitly marked block quote lines.
function protectedSpans(text) {
  const spans = [];
  const openings = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)|(^ {0,3}>[^\r\n]*(?:\r?\n {0,3}>[^\r\n]*)*)|`+/gm;
  let opening;
  while ((opening = openings.exec(text))) {
    let end;
    if (opening[1]) {
      const fence = opening[1];
      const closing = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \t]*(?=\r?$)', 'gm');
      closing.lastIndex = openings.lastIndex;
      const match = closing.exec(text);
      end = match ? closing.lastIndex : text.length;
    } else if (opening[2]) {
      end = openings.lastIndex;
    } else {
      const closing = /`+/g;
      closing.lastIndex = openings.lastIndex;
      let match;
      while ((match = closing.exec(text))) {
        if (match[0].length === opening[0].length) { end = closing.lastIndex; break; }
      }
      if (end === undefined) continue;
    }
    spans.push({ start: opening.index, end });
    openings.lastIndex = end;
  }
  return spans;
}

function quoteAndUrlSpans(text) {
  const spans = [];
  const openings = /https?:\/\/[^\s<>]+|["']/g;
  const ignoredUntil = { '"': 0, "'": 0 };
  const plainUntil = { '"': 0, "'": 0 };
  let opening;
  while ((opening = openings.exec(text))) {
    const start = opening.index;
    const quote = opening[0];
    if (quote.length > 1) {
      spans.push({ start, end: openings.lastIndex });
      continue;
    }
    if (start < ignoredUntil[quote] || (quote === "'" && wordAtEnd.test(text.slice(Math.max(0, start - 2), start)))) continue;
    let end = start + 1;
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n' && text[end] !== quote) {
      if (start >= plainUntil[quote] && text[end] === '\\' && end + 1 < text.length && text[end + 1] !== '\r' && text[end + 1] !== '\n') end += 2;
      else end++;
    }
    if (text[end] !== quote && start >= plainUntil[quote]) {
      // Escaped-only log payloads still have literal quote pairs. Once an
      // escape-aware scan fails, use plain delimiters forward to this line's end.
      plainUntil[quote] = end;
      end = start + 1;
      while (end < plainUntil[quote] && text[end] !== quote) end++;
    }
    if (text[end] === quote && (quote === '"' || !wordAtStart.test(text.slice(end + 1, end + 3)))) {
      spans.push({ start, end: end + 1 });
      openings.lastIndex = end + 1;
    } else {
      // Failed candidates cannot close before this boundary. Do not scan
      // their escaped quotes repeatedly; other quote types and URLs remain eligible.
      ignoredUntil[quote] = end;
    }
  }
  return spans;
}

function replaceLiterals(text, replace) {
  const spans = protectedSpans(text);
  // Ignore quotes inside Markdown, retaining offsets and line boundaries.
  // Surrounding quotes can still enclose a single-line Markdown span.
  let quoteInput = '';
  let maskedCursor = 0;
  for (const { start, end } of spans) {
    quoteInput += text.slice(maskedCursor, start) + text.slice(start, end).replace(/[^\r\n]/g, '\uFFFC');
    maskedCursor = end;
  }
  quoteInput += text.slice(maskedCursor);
  spans.push(...quoteAndUrlSpans(quoteInput));
  for (const match of quoteInput.matchAll(quotedWindowsPathPattern)) spans.push({ start: match.index, end: match.index + match[0].length });
  spans.sort((a, b) => a.start - b.start);
  // Quotes may enclose Markdown; a Windows path's final backslash may
  // resemble an escaped quote. Preserve the union of overlapping spans.
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push(span);
  }
  let result = '';
  let cursor = 0;
  for (const { start, end } of merged) {
    result += text.slice(cursor, start);
    result += replace(text.slice(start, end));
    cursor = end;
  }
  return result + text.slice(cursor);
}
class ProtectedContentError extends Error {}

export const protectionReminder = '\nThe previous attempt failed response or exact-content validation. Retry from the original message. Copy every protected GLAZER_LITERAL marker exactly once, unchanged, in body. Return exactly body, appreciation, workRequested, and encouragement. Body is the complete naturally integrated message. Appreciation must be a nonempty exact excerpt already in body. For source-requested work, encouragement must quote a distinct, nonoverlapping expression of support in body, not the gratitude or task; otherwise encouragement must be empty. Never rely on the tool to append annotations.';

export async function rewriteProtected(original, complete) {
  if (bypassRewrite(original)) return original;
  const protectedPrompt = protectPrompt(original);
  let correction = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rewritten = await complete(protectedPrompt.message, correction, protectedPrompt.tokens);
      return protectedPrompt.restore(rewritten);
    }
    catch (error) {
      if (!(error instanceof ProtectedContentError) || attempt === 1) throw error;
      correction = protectionReminder + '\nExact validation failure: ' + error.message;
    }
  }
}

export function composeRewrite(response) {
  let parts;
  try { parts = JSON.parse(response); }
  catch { throw new ProtectedContentError('Rewriter returned an invalid prompt: expected response fields.'); }
  if (!parts || Object.keys(parts).length !== 4 || typeof parts.workRequested !== 'boolean'
    || !['body', 'appreciation', 'encouragement'].every((key) => typeof parts[key] === 'string') || !parts.body.trim()) {
    throw new ProtectedContentError('Rewriter returned an invalid prompt: body, appreciation, workRequested, and encouragement are required.');
  }
  const body = parts.body.trim();
  const appreciationStart = body.indexOf(parts.appreciation);
  if (!parts.appreciation.trim() || appreciationStart < 0) {
    throw new ProtectedContentError('Rewriter returned an invalid prompt: appreciation must be a nonempty exact excerpt in body.');
  }
  if (parts.workRequested && appreciationStart === 0
    && (/[.!?。！？]["'”’]*$/.test(parts.appreciation.trim())
      || /^[.!?。！？]/.test(body.slice(parts.appreciation.length).trimStart()))) {
    throw new ProtectedContentError('Rewriter returned an invalid prompt: start work requests with source content, not a standalone appreciation sentence.');
  }
  if (parts.workRequested ? !parts.encouragement.trim() || !body.includes(parts.encouragement) : parts.encouragement !== '') {
    throw new ProtectedContentError('Rewriter returned an invalid prompt: source-requested work needs encouragement quoted from body; questions and observations need empty encouragement.');
  }
  if (parts.workRequested && (parts.appreciation === parts.encouragement
    || !(appreciationStart + parts.appreciation.length <= body.lastIndexOf(parts.encouragement)
      || body.indexOf(parts.encouragement) + parts.encouragement.length <= body.lastIndexOf(parts.appreciation)))) {
    throw new ProtectedContentError('Rewriter returned an invalid prompt: appreciation and work encouragement must quote distinct, nonoverlapping expressions in body.');
  }
  return body;
}

export function protectPrompt(original) {
  let prefix = 'GLAZER_LITERAL_';
  while (original.includes(prefix)) prefix += '_';
  const literals = [];
  const message = replaceLiterals(original, (literal) => {
    const token = `⟦${prefix}${literals.length}⟧`;
    literals.push({ token, literal });
    return token;
  });
  return { message, tokens: literals.map(({ token }) => token), restore(rewritten) {
    if (typeof rewritten !== 'string') throw new Error('Rewriter returned an invalid prompt.');
    rewritten = rewritten.trim();
    const byToken = new Map(literals.map(({ token, literal }) => [token, literal]));
    const counts = new Map();
    const parts = [];
    let cursor = 0;
    const unexpected = () => { throw new ProtectedContentError('Rewrite changed protected content (unexpected marker); no prompt was submitted.'); };
    for (const match of rewritten.matchAll(new RegExp('⟦' + prefix + '\\d+⟧', 'g'))) {
      const before = rewritten.slice(cursor, match.index);
      if (before.includes(prefix) || !byToken.has(match[0])) unexpected();
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      parts.push(before, byToken.get(match[0]));
      cursor = match.index + match[0].length;
    }
    const tail = rewritten.slice(cursor);
    if (tail.includes(prefix)) unexpected();
    parts.push(tail);
    for (const { token } of literals) {
      const count = counts.get(token) ?? 0;
      if (count !== 1) throw new ProtectedContentError(`Rewrite changed protected content (${token} must occur exactly once, found ${count}); no prompt was submitted.`);
    }
    // Every original literal is inserted verbatim exactly once. A second
    // per-literal scan of the restored output would only repeat that guarantee.
    return parts.join('');
  } };
}

export function validateRewrite(original, rewritten) {
  if (typeof rewritten !== 'string' || !rewritten.trim()) throw new Error('Rewriter returned an empty prompt.');
  // Technical literals are not sentiment. Refuse an edited or dropped literal.
  const literals = [];
  replaceLiterals(original, (literal) => { literals.push(literal); return literal; });
  const counts = new Map();
  for (const literal of literals) counts.set(literal, (counts.get(literal) ?? 0) + 1);
  for (const [literal, count] of counts) {
    if (rewritten.split(literal).length - 1 < count) throw new ProtectedContentError('Rewrite changed protected code; no prompt was submitted.');
  }
  return rewritten;
}
