import { readFileSync, writeFileSync } from 'node:fs';
import { parseAllDocuments, stringify } from '../../agent/node_modules/yaml/dist/index.js';
const keep = new Set(['snapshots.longhorn.io', 'backups.longhorn.io']);
const docs = parseAllDocuments(readFileSync(process.argv[2], 'utf8')).map((d) => d.toJS()).filter((d) => d?.kind === 'CustomResourceDefinition' && keep.has(d.metadata.name));
writeFileSync(process.argv[3], docs.map((d) => stringify(d)).join('---\n'));
console.log(docs.length);
