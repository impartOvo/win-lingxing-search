'use strict';
const { version } = require('../package.json');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must use major.minor.patch');
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/v${version}`) {
  throw new Error('Release tag does not match package.json');
}
process.stdout.write(version + '\n');
