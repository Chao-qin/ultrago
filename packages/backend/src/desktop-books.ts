import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeBookCode, paramSpecsToJsonSchema, parseCitation, type Playbook } from '@bcp/shared';

export const DESKTOP_BOOK_NAMES = ['baidu-hot-search', '1688-offer-snatch'] as const;

export async function isTrustedDesktopBook(book: Playbook, options: { desktop: boolean; directory?: string }): Promise<boolean> {
  if (!options.desktop || !options.directory || !DESKTOP_BOOK_NAMES.some((name) => name === book.name)) return false;
  try {
    const bundled = JSON.parse(await readFile(join(options.directory, `${book.name}.json`), 'utf8')) as Playbook;
    normalizeBookCode(bundled);
    const candidate = structuredClone(book);
    normalizeBookCode(candidate);
    // Console freezes delivery destinations before dispatch; script trust follows the unchanged executable definition.
    delete candidate.deliveries;
    delete bundled.deliveries;
    return isDeepStrictEqual(candidate, bundled);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function desktopBookSchemas(directory: string, rawSchema: string) {
  const inputs = await Promise.all(DESKTOP_BOOK_NAMES.map(async (name) => {
    const book = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8')) as Playbook & { paramSchemaRef: string };
    const citation = parseCitation(book.paramSchemaRef);
    return { ...citation, kind: 'book_input', jsonSchema: paramSpecsToJsonSchema(book.params || []), source: 'desktop-bundled' };
  }));
  return [...inputs, { name: 'raw-1688-offer', version: 2, kind: 'entity', entity: 'product', jsonSchema: JSON.parse(await readFile(rawSchema, 'utf8')), source: 'desktop-bundled' }];
}
