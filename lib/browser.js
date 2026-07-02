async function launchBrowser(extraArgs = []) {
  const { default: puppeteerExtra } = await import('puppeteer-extra');
  const { default: StealthPlugin }  = await import('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());

  if (process.env.RENDER) {
    const { default: chromium } = await import('@sparticuz/chromium');
    const executablePath = await chromium.executablePath();
    return puppeteerExtra.launch({
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
    return puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
    });
  }
}

module.exports = { launchBrowser };
