import puppeteer from 'puppeteer';

async function test() {
  console.log('Testing Puppeteer launch...');
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log('Success: Browser launched!');
    await browser.close();
  } catch (err) {
    console.error('Error: Browser launch failed!', err.message);
    console.log('Checking for installed Chrome...');
    // We will try to find system chrome path in next step if this fails
  }
}

test();