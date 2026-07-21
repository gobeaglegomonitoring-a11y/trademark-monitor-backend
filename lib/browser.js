let renderExecutablePathPromise;

async function launchBrowser(extraArgs = []) {
  const { default: puppeteerExtra } = await import('puppeteer-extra');
  const { default: StealthPlugin }  = await import('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());

  if (process.env.RENDER) {
    const { default: chromium } = await import('@sparticuz/chromium');
    // Chromium extraction is not safe when several state workers request it at
    // exactly the same time. Share one extraction promise across all launches.
    if (!renderExecutablePathPromise) {
      renderExecutablePathPromise = chromium.executablePath().catch(err => {
        renderExecutablePathPromise = null;
        throw err;
      });
    }
    const executablePath = await renderExecutablePathPromise;
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
      headless: 'new',
    });
  } else {
    return puppeteerExtra.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
    });
  }
}

module.exports = { launchBrowser };
