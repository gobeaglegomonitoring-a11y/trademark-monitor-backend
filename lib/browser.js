async function launchBrowser(extraArgs = []) {
  if (process.env.RENDER) {
    const chromium      = require('@sparticuz/chromium');
    const puppeteerCore = require('puppeteer-core');
    return puppeteerCore.launch({
      args:            [...chromium.args, ...extraArgs],
      defaultViewport: chromium.defaultViewport,
      executablePath:  chromium.executablePath,
      headless:        chromium.headless,
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
