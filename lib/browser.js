async function launchBrowser(extraArgs = []) {
  if (process.env.RENDER) {
    const chromiumModule = require('@sparticuz/chromium');
    const chromium       = chromiumModule.default || chromiumModule;
    const puppeteerCore  = require('puppeteer-core');
    const executablePath = typeof chromium.executablePath === 'function'
      ? await chromium.executablePath()
      : chromium.executablePath;
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
      args:     ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
    });
  }
}

module.exports = { launchBrowser };
