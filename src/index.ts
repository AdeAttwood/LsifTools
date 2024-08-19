import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {URI} from 'vscode-uri';
import {JsonDatabase} from './database';
import {print} from './printer';
import path from 'node:path';

export async function run(args: string[]) {
  const parsed = await yargs(hideBin(args))
    .command(
      'unused-definitions',
      'Find all the definitions that are not referenced',
      {
        file: {
          type: 'array',
          alias: 'f',
          demandOption: true,
          description: 'Path to the file you want to analyze',
        },
        dump: {
          type: 'array',
          alias: 'd',
          demandOption: true,
          description: 'Path to the lsif dump file',
        },
      },
      async function (args) {
        const database = new JsonDatabase();
        for (const dump of args.dump) {
          database.load(dump as string);
        }

        for (const file of args.file) {
          const uri = URI.parse(path.resolve(file as string)).toString();
          // database.allDefinitions(uri)
          for (const definition of database.allDefinitions(uri) ?? []) {
            const references = database.references(definition.uri, definition.range.start, {includeDeclaration: true});
            if (references && references.length === 1) {
              console.log(print(references[0]));
            }
          }
        }
      },
    )
    .showHelpOnFail(true)
    .strict()
    .parse();

    if (parsed._.length == 0) {
      yargs.showHelp();
    }
}
