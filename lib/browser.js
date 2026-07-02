async function launchBrowser(extraArgs = []) {
  if (process.env.RENDER) {
    const chromiumModule = require('@sparticuz/chromium');
    const chromium       = chromiumModule.default || chromiumModule;
    const puppeteerCore  = require('puppeteer-core');
    const baseArgs = Array.isArray(chromium.args) ? chromium.args : [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--single-process', '--no-zygote',
    ];
    return puppeteerCore.launch({
      args:            [...baseArgs, ...extraArgs],
      defaultViewport: chromium.defaultViewport || { width: 1280, height: 720 },
      executablePath:  chromium.executablePath,
      headless:        chromium.headless !== undefined ? chromium.headless : true,
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
