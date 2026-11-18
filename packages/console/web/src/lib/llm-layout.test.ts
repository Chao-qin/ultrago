import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const stylesheet = readFileSync(new URL('../pages/llm.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

test('desktop LLM overview keeps all five metrics on one row', () => {
  assert.match(rule('.llm-metrics'), /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
});

test('desktop LLM analysis stays readable while records remain independently navigable', () => {
  assert.match(rule('.llm-analysis-grid'), /height:\s*clamp\(360px,\s*42vh,\s*420px\)/);
  assert.match(rule('.llm-page > .llm-table-panel'), /height:\s*clamp\(520px,\s*62vh,\s*680px\)/);
});

test('compact desktop metrics preserve long values beside the expanded sidebar', () => {
  assert.match(stylesheet, /@media \(max-width: 1200px\) and \(min-width: 1051px\)/);
  assert.match(stylesheet, /\.llm-metric-icon\s*\{\s*display:\s*none;\s*\}/);
  assert.match(stylesheet, /\.llm-metric-value\s*\{\s*font-size:\s*22px;\s*margin-right:\s*0;\s*\}/);
});
