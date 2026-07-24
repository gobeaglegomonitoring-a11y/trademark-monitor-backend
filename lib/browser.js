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
        // Render's free tier has a hard ~512MB ceiling and the process gets
        // OS-killed (not a catchable JS error) if Chromium's own footprint
        // pushes past it — these trim memory that isn't needed for scraping.
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-default-apps',
        '--mute-audio',
        '--no-first-run',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
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
