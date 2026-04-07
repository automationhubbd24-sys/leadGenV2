import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// @ts-ignore
puppeteer.use(StealthPlugin());

async function testScraper(query: string, location: string) {
  console.log(`[TEST] Starting scraper for "${query}" in "${location}"...`);
  
  const browser = await (puppeteer as any).launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query + " in " + location)}`;
    console.log(`[TEST] Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    // Take a screenshot to verify what's happening
    await page.screenshot({ path: 'test-screenshot.png' });
    console.log("[TEST] Screenshot saved.");

    // Wait for the results list
    try {
      await page.waitForSelector('div[role="article"]', { timeout: 30000 });
      console.log("[TEST] Found results!");
    } catch (e) {
      const content = await page.content();
      console.log("[TEST] Results not found. Page HTML length:", content.length);
    }

    // Auto-scroll to load more leads
    console.log("[TEST] Scrolling to load ALL leads...");
    
    let lastLeadsCount = 0;
    let stableCount = 0;
    
    for (let i = 0; i < 30; i++) { // Increased to 30 scrolls for maximum results
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]') || document.body;
        feed.scrollBy(0, 3000);
      });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const currentLeads = await page.evaluate(() => document.querySelectorAll('div[role="article"]').length);
      console.log(`[TEST] Scroll ${i+1}: Found ${currentLeads} items...`);
      
      if (currentLeads === lastLeadsCount) {
        stableCount++;
        if (stableCount >= 4) break;
      } else {
        stableCount = 0;
        lastLeadsCount = currentLeads;
      }
    }

    // Extraction logic (Same as server.ts)
    const leads = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('div[role="article"]'));
      return items.map(item => {
        const nameEl = item.querySelector('div.fontHeadlineSmall') || item.querySelector('div[role="heading"]');
        const name = nameEl?.textContent || '';
        const link = (item.querySelector('a.hfpxzc') as HTMLAnchorElement)?.href || '';
        
        // --- AUDIT: RATING & REVIEWS ---
        let rating = '0';
        let reviews = '0';
        
        // Google Maps uses specific classes for rating and reviews
        // Rating: Usually inside a span with class like 'MW4etd'
        // Reviews: Usually inside a span with class like 'UY7F9'
        
        const ratingEl = item.querySelector('.MW4etd');
        if (ratingEl) rating = ratingEl.textContent || '0';

        const reviewsEl = item.querySelector('.UY7F9');
        if (reviewsEl) reviews = reviewsEl.textContent?.replace(/[^0-9]/g, '') || '0';

        // Try to find phone, website, and category
        const infoDivs = Array.from(item.querySelectorAll('.W4Efsd span:last-child'));
        let phone = '';
        let website = '';
        
        // The business category and info are often in these divs
        const infoText = Array.from(item.querySelectorAll('.W4Efsd')).map(d => d.textContent).join(' ');
        
        const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4,6}/;
        const phoneMatch = infoText.match(phoneRegex);
        if (phoneMatch) phone = phoneMatch[0].trim();

        // Website is often the only link that isn't a maps link
        const allLinks = Array.from(item.querySelectorAll('a'));
        const websiteLinkEl = allLinks.find(a => a.href && !a.href.includes('google.com/maps') && !a.href.includes('search?'));
        website = websiteLinkEl?.href || '';

        return {
          name: name.trim(),
          phone: phone.trim(),
          website: website, 
          rating: rating,
          reviews: reviews,
          mapsLink: link,
          debugInfo: infoText.substring(0, 100)
        };
      }).filter(l => l.name.length > 2);
    });

    console.log(`[TEST] TOTAL LEADS FOUND: ${leads.length}`);
    if (leads.length > 0) {
      console.log("[TEST] Sample Lead:", JSON.stringify(leads[0], null, 2));
    }

  } catch (err: any) {
    console.error("[TEST] Error during scraping:", err.message);
  } finally {
    await browser.close();
    console.log("[TEST] Browser closed.");
  }
}

// Run the test
testScraper("Restaurants", "New York").catch(console.error);
