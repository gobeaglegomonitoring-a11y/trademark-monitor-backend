async function launchBrowser(extraArgs = []) {
  if (process.env.RENDER) {
    const { default: chromium } = await import('@sparticuz/chromium');
    const puppeteerCore = require('puppeteer-core');
    const executablePath = await chromium.executablePath();
    return puppeteerCore.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        ...extraArgs,
      ],
      executablePath,
      headless: true,
    });
  } else {
    const { default: puppeteer } = await import('puppeteer');
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
    });
  }
}

module.exports = { launchBrowser };
