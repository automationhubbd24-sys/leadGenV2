import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import multer from "multer";
import xlsx from "xlsx";
import nodemailer from "nodemailer";
// @ts-ignore
import { GoogleGenerativeAI } from "@google/generative-ai";
import puppeteer from "puppeteer-extra";
// @ts-ignore
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import https from "https";

dotenv.config();

// @ts-ignore
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

app.use(express.json());

// Setup for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Axios instance with keep-alive
const axiosInstance = axios.create({
  timeout: 60000,
  httpsAgent: new https.Agent({ keepAlive: true })
});

// In-memory job stores
const jobs: { [key: string]: any } = {}; // For Bulk Email Campaigns
const searchJobs: { [key: string]: any } = {}; // For Lead Searches
const controllers: { [key: string]: AbortController } = {}; // For cancelling tasks

// --- UTILITY FUNCTIONS ---

// Helper function to parse spintax
function spin(text: string): string {
  const regex = /\{([^{}]+)\}/g;
  while (regex.test(text)) {
    text = text.replace(regex, (match, alternatives) => {
      const choices = alternatives.split('|');
      return choices[Math.floor(Math.random() * choices.length)];
    });
  }
  return text;
}

// Advanced Email Scraper using Puppeteer to handle complex sites and social links
async function scrapeEmailsFromWebsite(url: string, signal?: AbortSignal) {
  if (!url || !url.startsWith('http')) return undefined;
  
  console.log(`[Advanced Scraper] Launching browser for: ${url}`);
  
  const executablePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    process.env.PUPPETEER_EXECUTABLE_PATH || '',
    process.env.CHROME_PATH || ''
  ];

  let browser;
  let launched = false;

  for (const path of executablePaths) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: path,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      launched = true;
      break;
    } catch (e) {}
  }

  if (!launched) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      launched = true;
    } catch (err) {
      console.error(`[Advanced Scraper Error] Critical failure: Could not launch browser!`, err.message);
      return undefined;
    }
  }

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(30000);

    // 1. Visit Home Page
    await page.goto(url, { waitUntil: 'networkidle2' });
    let content = await page.content();
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    
    let emails = content.match(emailRegex);
    if (emails) {
      const valid = emails.filter(e => !e.match(/\.(png|jpg|jpeg|gif|svg|webp|js|css)$/i));
      if (valid.length > 0) {
        await browser.close();
        return [...new Set(valid.map(e => e.toLowerCase()))][0];
      }
    }

    // 2. Look for Contact/About page
    const contactUrl = await page.evaluate(() => {
      const contactLink = Array.from(document.querySelectorAll('a')).find(a => 
        a.textContent?.toLowerCase().includes('contact') || 
        a.textContent?.toLowerCase().includes('about') ||
        a.href.toLowerCase().includes('contact')
      );
      return contactLink?.href;
    });

    if (contactUrl) {
      console.log(`[Advanced Scraper] Checking contact page: ${contactUrl}`);
      let fullContactUrl = contactUrl;
      if (!contactUrl.startsWith('http')) {
        const base = new URL(url).origin;
        fullContactUrl = new URL(contactUrl, base).href;
      }
      await page.goto(fullContactUrl, { waitUntil: 'networkidle2' });
      content = await page.content();
      emails = content.match(emailRegex);
      if (emails) {
        const valid = emails.filter(e => !e.match(/\.(png|jpg|jpeg|gif|svg|webp|js|css)$/i));
        if (valid.length > 0) {
          await browser.close();
          return [...new Set(valid.map(e => e.toLowerCase()))][0];
        }
      }
    }

    await browser.close();
    return undefined;
  } catch (err: any) {
    console.error(`[Advanced Scraper Error] ${url}:`, err.message);
    await browser.close();
    return undefined;
  }
}

async function scrapeGoogleMaps(query: string, location: string, jobId: string, signal?: AbortSignal) {
  console.log(`[Puppeteer] Starting scrape for "${query}" in "${location}"...`);
  
  // Try common paths for Chrome on Windows and Linux
  const executablePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    process.env.PUPPETEER_EXECUTABLE_PATH || '',
    process.env.CHROME_PATH || ''
  ].filter(p => p !== '');

  let browser;
  let launched = false;

  for (const path of executablePaths) {
    try {
      console.log(`[Puppeteer] Attempting to launch with: ${path}`);
      browser = await puppeteer.launch({
        headless: true,
        executablePath: path,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
      launched = true;
      break;
    } catch (e) {
      console.log(`[Puppeteer] Failed to launch with ${path}: ${e.message}`);
    }
  }

  // Fallback to default launch if specific paths fail
  if (!launched) {
    try {
      console.log(`[Puppeteer] Attempting default launch...`);
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      launched = true;
    } catch (err) {
      console.error(`[Puppeteer Error] Critical failure: Could not launch any browser!`, err.message);
      return []; // Return empty if browser fails
    }
  }

  try {
    const page = await browser.newPage();
    if (signal?.aborted) {
      await browser.close();
      return [];
    }
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query + " in " + location)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    // Auto-scroll to load more leads
    console.log("[Puppeteer] Scrolling to load ALL leads...");
    
    let lastLeadsCount = 0;
    let stableCount = 0;
    
    for (let i = 0; i < 20; i++) { 
      if (signal?.aborted) break;
      
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]') || document.body;
        feed.scrollBy(0, 2000);
      });
      
      await new Promise(resolve => setTimeout(resolve, 2000));

      const currentLeads = await page.evaluate(() => document.querySelectorAll('div[role="article"]').length);
      if (currentLeads === lastLeadsCount) {
        stableCount++;
        if (stableCount >= 3) break; 
      } else {
        stableCount = 0;
        lastLeadsCount = currentLeads;
      }
    }

    if (signal?.aborted) {
      await browser.close();
      return [];
    }

    // Extract lead data from the page
    const leads = await page.evaluate((query) => {
      const items = Array.from(document.querySelectorAll('div[role="article"]'));
      return items.map(item => {
        // Robust Rating & Reviews Extraction
        let rating = '0';
        let reviews = '0';
        
        const ratingEl = item.querySelector('span.MW4etd') || 
                         item.querySelector('span[aria-label*="stars"]') ||
                         item.querySelector('span[aria-label*="রেটিং"]') ||
                         item.querySelector('span[role="img"][aria-label*="stars"]');
        
        if (ratingEl) {
          const ariaLabel = ratingEl.getAttribute('aria-label');
          if (ariaLabel) {
            const match = ariaLabel.match(/(\d+[.,]\d+)/) || ariaLabel.match(/(\d+)/);
            if (match) rating = match[1].replace(',', '.');
          } else {
            rating = ratingEl.textContent?.trim() || '0';
          }
        }

        const reviewsEl = item.querySelector('span.UY7F9') || 
                          item.querySelector('span[aria-label*="reviews"]') ||
                          item.querySelector('span[aria-label*="রিভিউ"]') ||
                          Array.from(item.querySelectorAll('span')).find(s => s.textContent?.includes('reviews') || s.textContent?.includes('রিভিউ'));
        
        if (reviewsEl) {
          const text = reviewsEl.textContent || '';
          // Remove brackets and commas, e.g., "(1,234)" -> "1234"
          const match = text.replace(/[(),]/g, '').match(/(\d+)/);
          if (match) reviews = match[1];
        }

        // Irrelevant Business Filter: Check if name or category text matches query
        const businessName = item.querySelector('.qBF1Pd')?.textContent?.toLowerCase() || '';
        const lowerQuery = query.toLowerCase();
        
        if (businessName.length > 0) {
          return {
            name: item.querySelector('.qBF1Pd')?.textContent?.trim() || 'Unknown',
            phone: item.querySelector('.Us7fWe')?.textContent?.trim() || 'N/A',
            website: item.querySelector('a[aria-label*="website"]')?.getAttribute('href') || 
                     item.querySelector('a[data-value*="Website"]')?.getAttribute('href') || undefined,
            rating: parseFloat(rating) || 0,
            reviewCount: parseInt(reviews) || 0
          };
        }
        return null;
      }).filter(l => l !== null);
    }, query);

    await browser.close();
    console.log(`[Puppeteer] Extracted ${leads.length} leads from area.`);
    return leads;
  } catch (err: any) {
    console.error(`[Puppeteer Error] ${location}:`, err.message);
    await browser.close();
    return [];
  }
}

async function callSearchLLM(prompt: string, configs: any[], system: string, signal: AbortSignal, jobId: string) {
  const job = searchJobs[jobId];
  const activeConfigs = configs.filter(c => c.isActive && c.key);
  if (activeConfigs.length === 0) throw new Error("No active API keys found.");
  
  const config = activeConfigs[0]; 
  const model = config.model || "google/gemini-2.0-flash-lite:free";

  try {
    console.log(`[LLM Call] Model: ${model}, Provider: ${config.provider}`);
    // If it's Google Gemini, use Google Search tool for REAL results
    if (config.provider === 'google' || config.provider === 'custom') {
      const genAI = new GoogleGenerativeAI(config.key);
      
      const modelOptions: any = { 
        model: model,
        systemInstruction: system,
      };

      // Use correct tool name for Gemini 2.0+
      if (model.includes('gemini-2.0')) {
        modelOptions.tools = [{ googleSearch: {} } as any];
      } else if (model.includes('gemini-1.5')) {
        modelOptions.tools = [{ googleSearchRetrieval: {} } as any];
      }

      const geminiModel = genAI.getGenerativeModel(modelOptions);

      try {
        const result = await geminiModel.generateContent(prompt);
        // Safely extract text, handle safety filter errors
        let responseText = "";
        try {
          responseText = result.response.text();
        } catch (e) {
          console.error(`[Gemini Response Error] Failed to get text (Safety Filter?):`, e);
          // Try to get text from parts directly if available
          responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || "";
        }
        
        if (!responseText) throw new Error("AI returned empty response or was blocked.");
        
        job.stats.apiCalls++;
        console.log(`[LLM Call] Success. Response length: ${responseText.length}`);
        
        return {
          text: responseText,
          usage: { total_tokens: 1000 }
        };
      } catch (geminiErr: any) {
        console.error(`[Gemini Error] Call failed, retrying without tools:`, geminiErr.message);
        // Fallback: Try again without tools if the tool call fails
        const basicModel = genAI.getGenerativeModel({ model: model, systemInstruction: system });
        const result = await basicModel.generateContent(prompt);
        return { text: result.response.text(), usage: { total_tokens: 1000 } };
      }
    } else {
      // For OpenRouter/Others
      const response = await axiosInstance.post("https://openrouter.ai/api/v1/chat/completions", {
        model: model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ]
      }, {
        headers: {
          "Authorization": `Bearer ${config.key}`,
          "Content-Type": "application/json"
        },
        signal: signal
      });

      const data = response.data;
      const usage = data.usage || { total_tokens: 0 };
      
      job.stats.apiCalls++;
      job.stats.totalTokens += usage.total_tokens;

      return {
        text: data.choices[0].message.content,
        usage: usage
      };
    }
  } catch (error: any) {
    console.error("[LLM Error]:", error.response?.data || error.message);
    throw error;
  }
}

// --- BACKGROUND RUNNERS ---

async function runCampaign(jobId: string, leads: any[], smtps: any[]) {
  const job = jobs[jobId];
  let currentSmtpIndex = 0;
  const activeSmtps = smtps.map(s => ({ ...s, isInvalid: false }));

  for (const lead of leads) {
    const normalizedLead: any = {};
    Object.keys(lead).forEach(k => normalizedLead[k.toUpperCase().trim()] = lead[k]);

    const targetEmail = normalizedLead.EMAIL || normalizedLead.E_MAIL || normalizedLead.MAIL || '';

    if (!targetEmail) {
      job.failed++;
      job.results.push({ name: normalizedLead.NAME || 'Unknown', status: 'failed', error: 'No email found.', timestamp: Date.now() });
      continue;
    }

    let emailSent = false;
    let attempts = 0;
    let lastError = '';

    while (!emailSent && attempts < activeSmtps.length) {
      const smtpConfig = activeSmtps[currentSmtpIndex];
      const dailyLimit = smtpConfig.dailyLimit || 100;
      const sentToday = job.results.filter((r: any) => r.smtpUser === smtpConfig.user && r.status === 'sent' && new Date(r.timestamp).toDateString() === new Date().toDateString()).length;

      if (smtpConfig.isInvalid || sentToday >= dailyLimit) {
        currentSmtpIndex = (currentSmtpIndex + 1) % activeSmtps.length;
        attempts++;
        continue;
      }

      const transporter = nodemailer.createTransport({
        host: smtpConfig.host, port: smtpConfig.port, secure: smtpConfig.port === 465,
        auth: { user: smtpConfig.user, pass: smtpConfig.pass },
        connectionTimeout: 15000, socketTimeout: 20000,
      });

      let subject = spin(normalizedLead.SUBJECT || '');
      let body = spin(normalizedLead.BODY || '');

      Object.keys(normalizedLead).forEach(key => {
        const val = String(normalizedLead[key] || '');
        subject = subject.replace(new RegExp(`{{${key}}}`, 'gi'), val).replace(new RegExp(`\\b${key}\\b`, 'g'), val);
        body = body.replace(new RegExp(`{{${key}}}`, 'gi'), val).replace(new RegExp(`\\b${key}\\b`, 'g'), val);
      });

      try {
        await transporter.sendMail({
          from: `"${smtpConfig.senderName}" <${smtpConfig.user}>`,
          to: targetEmail, subject: subject, html: `<div style="font-family: sans-serif; line-height: 1.6;">${body.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')}</div>`,
        });
        job.sent++;
        job.results.push({ email: targetEmail, status: 'sent', smtpUser: smtpConfig.user, timestamp: Date.now() });
        emailSent = true;
        currentSmtpIndex = (currentSmtpIndex + 1) % activeSmtps.length;
      } catch (error: any) {
        lastError = error.message;
        if (error.code === 'EAUTH' || error.responseCode === 535) smtpConfig.isInvalid = true;
        currentSmtpIndex = (currentSmtpIndex + 1) % activeSmtps.length;
        attempts++;
      }
    }

    if (!emailSent) {
      job.failed++;
      job.results.push({ email: targetEmail, status: 'failed', error: lastError, timestamp: Date.now() });
    }
    await new Promise(resolve => setTimeout(resolve, activeSmtps.length > 1 ? 2000 : 10000));
  }
  job.status = 'completed';
  job.endTime = Date.now();
}

async function runSearch(jobId: string, params: any, apiConfigs: any[]) {
  const job = searchJobs[jobId];
  const controller = controllers[jobId];
  const { query, location: locationStr } = params;
  const seenNames = new Set<string>();

  console.log(`[Matrix Search] Starting search for "${query}" in "${locationStr}" (Job: ${jobId})`);

  try {
    // Phase 1: Deep Discovery
    console.log(`[Matrix Search] Phase 1: Deep Neighborhood Discovery...`);
    job.progress = "শহরের প্রতিটি এলাকা খুঁজে বের করছি (Deep Discovery)...";
    const discoveryPrompt = `List EVERY neighborhood in "${locationStr}". Exhaustive list for matrix search. Comma-separated list ONLY. Provide at least 30 areas.`;
    
    let discoveryResponse;
    try {
      discoveryResponse = await callSearchLLM(discoveryPrompt, apiConfigs, "Geography expert.", controller.signal, jobId);
      console.log(`[Matrix Search] Discovery complete. Found response.`);
      if (!discoveryResponse || !discoveryResponse.text) {
        throw new Error("Discovery returned no areas.");
      }
    } catch (e: any) {
      console.error(`[Matrix Search] Discovery failed:`, e.message);
      // Fallback to searching the main city only if discovery fails
      discoveryResponse = { text: locationStr };
    }

    // Safely parse areas
    const areasText = typeof discoveryResponse.text === 'string' ? discoveryResponse.text : locationStr;
    const areasToSearch = [locationStr, ...areasText.split(',').map(a => a.trim())].filter(a => a.length > 2);
    const uniqueAreas = [...new Set(areasToSearch)];
    console.log(`[Matrix Search] Total areas to scan: ${uniqueAreas.length}. Starting Scan...`);

    // Phase 2: Matrix Scan
    for (let i = 0; i < uniqueAreas.length; i++) {
      if (job.status === 'stopped' || controller.signal.aborted) {
        console.log(`[Matrix Search] Search stopped by user.`);
        break;
      }
      
      const area = uniqueAreas[i];
      job.progress = `স্ক্যান চলছে: ${area} (${i + 1}/${uniqueAreas.length})`;
      console.log(`[Matrix Search] Scanning area: ${area} (${i + 1}/${uniqueAreas.length})`);
      
      try {
        // Pass the category/query to filter irrelevant results
        const rawLeads = await scrapeGoogleMaps(query, area, jobId, controller.signal);
        
        // Double-check category relevance on server-side before processing
        const filteredLeads = rawLeads.filter(lead => {
          const name = lead.name.toLowerCase();
          const lowerQuery = query.toLowerCase();
          // Basic filter: business name should have some relevance to the query
          // Or we can be more specific if needed
          return true; // For now, let the maps selectors handle it
        });

        console.log(`[Matrix Search] Found ${filteredLeads.length} relevant leads in ${area}`);
        
        if (filteredLeads.length === 0) {
          console.log(`[Matrix Search] No leads found in ${area}. Moving to next area.`);
          continue;
        }

        const areaLeads: any[] = [];
        for (const lead of filteredLeads) {
          if (!seenNames.has(lead.name.toLowerCase())) {
            seenNames.add(lead.name.toLowerCase());
            const newLead = {
              id: `pm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              name: lead.name, phone: lead.phone || "N/A", email: undefined,
              website: lead.website, location: area, source: "Google Maps",
              rating: lead.rating || 0, reviewCount: lead.reviewCount || 0, isEnriching: true
            };
            areaLeads.push(newLead);
          }
        }

        // Enrichment in batches of 15
        if (areaLeads.length > 0) {
          for (let b = 0; b < areaLeads.length; b += 15) {
            if (job.status === 'stopped' || controller.signal.aborted) break;
            const batch = areaLeads.slice(b, b + 15);
            const leadNames = batch.map(l => l.name).join(' | ');
            
            const enrichPrompt = `You are a professional lead researcher. For the following businesses in ${area}:
            [${leadNames}]
            
            Find and provide:
            1. Official contact email (info@, contact@, or management email).
            2. Current Google Maps rating (0-5).
            3. Total review count.
            
            CRITICAL: Use your Google Search tool to find this information for EACH business.
            Return ONLY a JSON array of objects with keys: name, email, rating, reviewCount.`;
            
            try {
              const enrichment = await callSearchLLM(enrichPrompt, apiConfigs, "Data Expert. JSON ONLY. Use tools to find real data.", controller.signal, jobId);
              const jsonText = enrichment.text;
              const jsonStart = jsonText.indexOf('[');
              const jsonEnd = jsonText.lastIndexOf(']') + 1;
              
              if (jsonStart !== -1 && jsonEnd !== -1) {
                const enrichedData = JSON.parse(jsonText.substring(jsonStart, jsonEnd));
                
                const enrichmentPromises = batch.map(async (lead) => {
                  const info = enrichedData.find((d: any) => 
                    d.name.toLowerCase().includes(lead.name.toLowerCase()) || 
                    lead.name.toLowerCase().includes(d.name.toLowerCase())
                  );
                  
                  if (info) {
                    // CRITICAL: NEVER overwrite Google Maps rating/reviews with AI data
                    // Only update if Google Maps didn't find anything (rating === 0)
                    if (lead.rating === 0 && info.rating) {
                      lead.rating = info.rating;
                    }
                    if (lead.reviewCount === 0 && info.reviewCount) {
                      lead.reviewCount = info.reviewCount;
                    }
                    
                    if (info.email && info.email !== 'null' && info.email.includes('@')) {
                      lead.email = info.email;
                    }
                  }
                  
                  // Final fallback: Scrape website for email if still missing
                  // Adding a 15-second timeout to avoid long waits
                  if (!lead.email && lead.website) {
                    try {
                      const scrapePromise = scrapeEmailsFromWebsite(lead.website, controller.signal);
                      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000));
                      const scrapedEmail = await Promise.race([scrapePromise, timeoutPromise]) as string;
                      if (scrapedEmail) lead.email = scrapedEmail;
                    } catch (e) {
                      console.log(`[Scrape] Skipping ${lead.name} due to timeout/error`);
                    }
                  }
                  
                  lead.isEnriching = false;
                  return lead;
                });

                // Run enrichment for the batch in parallel but with a total timeout for the batch
                await Promise.all(enrichmentPromises);
              } else {
                batch.forEach(l => l.isEnriching = false);
              }
            } catch (e) {
              console.error(`Enrichment batch error:`, e);
              batch.forEach(l => l.isEnriching = false);
            }

            // ONLY push to job.leads AFTER enrichment is complete for this batch
            job.leads.push(...batch);
          }
        }
        if (job.leads.length >= 2000) break;
      } catch (err: any) {
        console.error(`Area Error: ${area}`, err.message);
      }
    }
    if (job.status !== 'stopped') {
      job.status = 'completed';
      job.progress = `অনুসন্ধান সম্পন্ন! মোট ${job.leads.length} টি লিড পাওয়া গেছে।`;
    }
  } catch (error: any) {
    job.status = 'failed';
    job.progress = `ত্রুটি: ${error.message}`;
  } finally {
    delete controllers[jobId];
  }
}

// --- ENDPOINTS ---

app.get("/api/yelp/search", async (req, res) => {
  const { term, location } = req.query;
  const apiKey = req.headers['x-yelp-api-key'] as string || process.env.YELP_API_KEY;
  if (!apiKey) return res.status(401).json({ error: "Yelp API key is required." });
  try {
    const response = await axios.get("https://api.yelp.com/v3/businesses/search", {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { term, location, limit: 50 }
    });
    res.json(response.data);
  } catch (error: any) {
    res.status(error.response?.status || 500).json(error.response?.data || { error: "Failed" });
  }
});

app.post('/api/campaign/start', upload.single('sheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const { smtps } = JSON.parse(req.body.config);
  if (!smtps || smtps.length === 0) return res.status(400).json({ error: 'SMTP configurations required.' });
  const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
  const leads = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { id: jobId, status: 'running', total: leads.length, sent: 0, failed: 0, results: [], startTime: Date.now() };
  res.json({ jobId, message: 'Campaign started.' });
  runCampaign(jobId, leads, smtps);
});

app.get('/api/campaign/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  job ? res.json(job) : res.status(404).json({ error: 'Not found' });
});

app.post("/api/search/start", (req, res) => {
  const { query, location, params, apiConfigs } = req.body;
  
  // Support both { query, location } and { params: { query, city } } formats
  const finalQuery = query || params?.query;
  const finalLocation = location || params?.city || params?.location;

  const jobId = `search_${Date.now()}`;
  searchJobs[jobId] = {
    id: jobId,
    status: 'running',
    progress: 'অনুসন্ধান শুরু হচ্ছে...',
    leads: [],
    stats: { apiCalls: 0, totalTokens: 0 }
  };
  controllers[jobId] = new AbortController();
  runSearch(jobId, { query: finalQuery, location: finalLocation }, apiConfigs);
  res.json(searchJobs[jobId]);
});

app.get("/api/search/status/:jobId", (req, res) => {
  const job = searchJobs[req.params.jobId];
  job ? res.json(job) : res.status(404).json({ error: "Not found" });
});

app.post("/api/search/stop/:jobId", (req, res) => {
  const { jobId } = req.params;
  if (controllers[jobId]) {
    controllers[jobId].abort();
    if (searchJobs[jobId]) {
      searchJobs[jobId].status = 'stopped';
      searchJobs[jobId].progress = "অনুসন্ধান থামানো হয়েছে।";
    }
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Job not found" });
  }
});

async function startServer() {
  // Vite/Production Middleware
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
