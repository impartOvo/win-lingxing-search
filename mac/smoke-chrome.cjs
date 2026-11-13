'use strict';
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>Lingxing platform check</title>');
    if (await page.title() !== 'Lingxing platform check') throw new Error('Chrome 连接检查失败');
    console.log(JSON.stringify({ chrome: 'ok', platform: process.platform, arch: process.arch }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
