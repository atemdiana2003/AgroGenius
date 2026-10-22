import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const spec = readFileSync(resolve('docs/openapi.yaml'), 'utf8');
const pathEntries = [...spec.matchAll(/^\x20{2}(\/[^:\r\n]+):\s*$/gm)];
const checks = [
  ['/payments/offers/{id}', 'post'],
  ['/payments/{id}', 'get'],
  ['/payments/fapshi/webhook', 'post'],
];
const errors = [];

for (const [path, method] of checks) {
  const index = pathEntries.findIndex((entry) => entry[1] === path);
  if (index === -1) {
    errors.push(`Missing OpenAPI path ${path}.`);
    continue;
  }
  const start = pathEntries[index].index;
  const end = pathEntries[index + 1]?.index ?? spec.length;
  const block = spec.slice(start, end);
  if (!new RegExp(`^\\x20{4}${method}:`, 'm').test(block)) {
    errors.push(`Missing ${method.toUpperCase()} operation for ${path}.`);
  }
}

for (const field of ['amount:', 'currency:', 'provider:', 'mode:', 'status:', 'checkoutUrl:']) {
  if (!spec.includes(`        ${field}`)) errors.push(`Missing Payment schema field ${field}`);
}
if (!spec.includes('name: x-wh-secret'))
  errors.push('Missing Fapshi webhook authentication header.');
if (!spec.includes('enum: [CREATED, PENDING, SUCCESSFUL, FAILED, EXPIRED, INITIATION_UNKNOWN]')) {
  errors.push('Payment lifecycle enum is missing or incomplete.');
}

if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('OpenAPI payment paths and schema contract checks passed.\n');
}
