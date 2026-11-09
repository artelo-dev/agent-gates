/** Built-in content-lint rules (no lorem, TODO, example.com, empty href, placeholders). */

export interface ContentRule {
  id: string;
  message: string;
  /** Must be global (`g`) — every match is reported. */
  pattern: RegExp;
  /**
   * Optional per-match filter. Returns false to drop a match (e.g. a `{NAME}` JSX expression that
   * references a real identifier in a code file).
   */
  accept?: (match: RegExpExecArray, file: { text: string; isCode: boolean; path: string }) => boolean;
}

const PLACEHOLDER = /(?<![$\w])\{\{\s*[A-Za-z][\w.-]*\s*\}\}|(?<![$\w{])\{[A-Z][A-Z0-9_]{2,}\}(?!\})/g;

function placeholderName(match: string): string {
  return match.replace(/[{}\s]/g, '');
}

/**
 * In code files `{SITE_URL}` is usually a JSX expression. Treat it as a placeholder only when the
 * name never appears outside of `{NAME}` braces (so it is not imported/declared anywhere).
 */
function acceptPlaceholder(match: RegExpExecArray, file: { text: string; isCode: boolean }): boolean {
  if (!file.isCode || match[0].startsWith('{{')) return true;
  const name = placeholderName(match[0]);
  const all = file.text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
  const braced = file.text.match(new RegExp(`(?<![$\\w{])\\{${name}\\}`, 'g'))?.length ?? 0;
  return all <= braced;
}

/** Heuristic: the match sits in a line comment, a block comment, or a JSDoc continuation line. */
function inComment(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  if (/^\s*(?:\*|\/\*|\{\s*\/\*)/.test(prefix)) return true;
  if (/(?:^|[^:'"`])\/\//.test(prefix)) return true;
  const open = text.lastIndexOf('/*', index);
  return open !== -1 && open >= lineStart - 2000 && text.indexOf('*/', open) > index;
}

/**
 * Prose (docs, READMEs) and comments talk ABOUT placeholders; only shipped copy counts. Copy here
 * means a capitalised "Placeholder…" that starts a text node: after `>` (JSX/HTML text) or an opening
 * quote, and in data files also after `key:` or a `- ` list marker (YAML). Identifiers, log messages
 * and lowercase mid-sentence mentions stay quiet.
 */
function acceptPlaceholderCopy(m: RegExpExecArray, file: { text: string; isCode: boolean; path: string }): boolean {
  if (/\.(?:md|mdx|txt)$/i.test(file.path)) return false;
  if (!/^Placeholders?$/.test(m[0])) return false;
  if (file.isCode && inComment(file.text, m.index)) return false;
  const lineStart = file.text.lastIndexOf('\n', m.index - 1) + 1;
  const line = file.text.slice(lineStart, m.index);
  if (!file.isCode && /\.ya?ml$/i.test(file.path) && line.includes('#')) return false;
  const before = file.text.slice(Math.max(0, m.index - 200), m.index).replace(/\s+$/, '');
  const prev = before[before.length - 1];
  if (prev === '>' || prev === '"' || prev === "'" || prev === '`') return true;
  return !file.isCode && (prev === ':' || /^\s*-$/.test(line.trimEnd()) || line.trim() === '');
}

export const BUILTIN_CONTENT_RULES: readonly ContentRule[] = [
  {
    id: 'lorem',
    message: 'lorem ipsum placeholder text',
    pattern: /\blorem(?:\s+ipsum)?\b/gi,
  },
  {
    id: 'todo',
    message: 'TODO/FIXME/TBD marker',
    pattern: /\b(?:TODO|FIXME|TBD)\b/g,
  },
  {
    id: 'example-domain',
    message: 'example.com/org/net placeholder domain',
    pattern: /\b(?:[\w-]+\.)*example\.(?:com|org|net)\b/gi,
  },
  {
    id: 'empty-href',
    message: 'empty or "#" href',
    pattern: /\bhref\s*=\s*(?:\{\s*)?(["'`])#?\1|"href"\s*:\s*"#?"|\]\(\s*#?\s*\)/g,
  },
  {
    // "Placeholder headline", "Placeholder CTA": how agents mark copy they did not write.
    // Never the `placeholder` attribute/prop/key, `.placeholder`, paths, CSS `::placeholder` or Tailwind `placeholder:`.
    id: 'placeholder-text',
    message: 'placeholder copy',
    pattern: /(?<![\w.:\-$/])placeholders?\b(?![\w-]|\s*[=:(?]|['"`]\s*[:\]])/gi,
    accept: acceptPlaceholderCopy,
  },
  {
    id: 'fill-in-text',
    message: 'fill-in template text',
    pattern: /\b(?:your|insert)\s+(?:[\w-]+\s+){0,3}here\b/gi,
  },
  {
    id: 'placeholder',
    message: 'unfilled placeholder',
    pattern: PLACEHOLDER,
    accept: acceptPlaceholder,
  },
];

/** Rules from gates.yaml `patterns` (regex sources). */
export function customRules(patterns: readonly string[]): ContentRule[] {
  return patterns.map((source, i) => ({
    id: `pattern:${i + 1}`,
    message: `forbidden pattern /${source}/`,
    pattern: new RegExp(source, 'g'),
  }));
}
