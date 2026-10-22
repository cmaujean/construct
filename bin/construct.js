#!/usr/bin/env node
'use strict';

if (!process.features?.typescript) {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const res = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      path.join(__dirname, 'construct.ts'),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', windowsHide: true }
  );
  process.exit(res.status ?? 1);
}

require('./construct.ts');
