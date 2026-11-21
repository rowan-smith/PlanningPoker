/**
 * Converts Jira text values to plain text. Jira Cloud v3 returns rich text as Atlassian Document
 * Format (ADF), but some responses carry plain strings, so both are accepted. The result is text
 * only — no markup survives — and the UI must still render it as text, never as HTML.
 */

const DEFAULT_MAX_LENGTH = 5000;
const ELLIPSIS = '…';

const BLOCK_NODES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'rule',
  'panel',
  'table',
  'tableRow',
  'mediaSingle',
  'mediaGroup',
  'expand',
  'nestedExpand',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attribute(node: Record<string, unknown>, name: string): string | null {
  const attrs = node.attrs;
  const value = isRecord(attrs) ? attrs[name] : undefined;

  return typeof value === 'string' ? value : null;
}

function nodeText(node: unknown, listDepth: number): string {
  if (!isRecord(node)) {
    return '';
  }

  const children = Array.isArray(node.content) ? node.content : [];
  const inner = (depth = listDepth): string =>
    children.map((child) => nodeText(child, depth)).join('');

  switch (node.type) {
    case 'text':
      return typeof node.text === 'string' ? node.text : '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return attribute(node, 'text') ?? '@someone';
    case 'emoji':
      return attribute(node, 'text') ?? attribute(node, 'shortName') ?? '';
    case 'inlineCard':
    case 'blockCard':
      return attribute(node, 'url') ?? '';
    case 'status':
      return attribute(node, 'text') ?? '';
    case 'date':
      return attribute(node, 'timestamp') ?? '';
    case 'bulletList':
    case 'orderedList':
      return `${inner(listDepth + 1)}\n`;
    case 'listItem':
      return `${'  '.repeat(Math.max(listDepth - 1, 0))}• ${inner().trim()}\n`;
    case 'tableCell':
    case 'tableHeader':
      return `${inner().trim()}\t`;
    default:
      return typeof node.type === 'string' && BLOCK_NODES.has(node.type)
        ? `${inner().trimEnd()}\n\n`
        : inner();
  }
}

/** Returns plain text for an ADF document, a plain string, or null when there is nothing. */
export function richTextToPlain(value: unknown, maxLength = DEFAULT_MAX_LENGTH): string | null {
  const raw = typeof value === 'string' ? value : nodeText(value, 0);
  const text = raw.replace(/\n{3,}/g, '\n\n').trim();

  if (text.length === 0) {
    return null;
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}${ELLIPSIS}` : text;
}

const DISPLAY_VALUE_MAX = 200;

/**
 * Text for a field shown on a ticket: strings, numbers, options, users, arrays of those, and rich
 * text. Returns null for values that have no sensible text.
 */
export function fieldValueToText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return richTextToPlain(String(value), DISPLAY_VALUE_MAX);
  }

  if (Array.isArray(value)) {
    const parts = value.map(fieldValueToText).filter((part): part is string => part !== null);

    return parts.length === 0 ? null : richTextToPlain(parts.join(', '), DISPLAY_VALUE_MAX);
  }

  if (isRecord(value)) {
    if (value.type === 'doc') {
      return richTextToPlain(value, DISPLAY_VALUE_MAX);
    }

    for (const key of ['displayName', 'name', 'value', 'key']) {
      const candidate = value[key];

      if (typeof candidate === 'string' && candidate.length > 0) {
        return richTextToPlain(candidate, DISPLAY_VALUE_MAX);
      }
    }
  }

  return null;
}
