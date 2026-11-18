import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const component = readFileSync(new URL('../components/LlmAccessEditor.tsx', import.meta.url), 'utf8');
const stylesheet = readFileSync(new URL('../components/llm-access-editor.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

test('API key names keep a readable column instead of wrapping one character per line', () => {
  assert.match(component, /title: "名称",\s*dataIndex: "name",\s*width: 120/);
  assert.match(component, /className="llm-access-key-name"/);
  assert.match(rule('.llm-access-key-name'), /white-space:\s*nowrap/);
  assert.match(rule('.llm-access-key-name'), /text-overflow:\s*ellipsis/);
});

test('API key table preserves its column geometry in a narrow drawer', () => {
  assert.match(component, /tableLayout="fixed"/);
  assert.match(component, /scroll=\{\{ x: 870 \}\}/);
});

test('API key actions leave secondary operations in the overflow menu', () => {
  assert.match(component, /<RowActions\s+maxInline=\{2\}/);
});
