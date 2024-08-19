import {types} from '@vscode/lsif-protocol';
import {URI} from 'vscode-uri';
import {readFileSync} from 'node:fs';

export function print(location: types.Location, context: number = 3) {
  const uri = URI.parse(location.uri);
  let contentResult: string[] = [];
  if (uri.scheme === 'file') {
    const content = readFileSync(uri.fsPath, 'utf-8').trim().split('\n');
    for (let i = location.range.start.line - context; i <= location.range.end.line + context; i++) {
      const line = content[i];
      const lineContent = i === location.range.start.line ? ` > ${i + 1}: ${line}` : `   ${i + 1}: ${line}`;
      contentResult.push(lineContent);
    }
  }

  return [
    `${location.uri}:${location.range.start.line + 1}:${location.range.start.character + 1}`,
    ...contentResult,
    '',
  ].join('\n');
}
