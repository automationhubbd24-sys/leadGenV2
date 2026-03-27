import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import multer from "multer";
import xlsx from "xlsx";
import nodemailer from "nodemailer";
import { GoogleGenAI } from "@google/genai";
import https from "https";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

dotenv.config();

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Axios Global Configuration for better stability
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ 
    keepAlive: true,
    rejectUnauthorized: false // Sometimes needed for certain environments
  }),
  timeout: 60000,
  headers: {
    'User-Agent': 'LeadGenPro/1.0',
    'Accept': 'application/json'
  }
});

// Setup for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// In-memory job store
const jobs: { [key: string]: any } = {};
const searchJobs: { [key: string]: any } = {};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Yelp API Proxy
  app.get("/api/yelp/search", async (req, res) => {
    const { term, location } = req.query;
    const apiKey = req.headers['x-yelp-api-key'] as string || process.env.YELP_API_KEY;

    if (!apiKey) {
      return res.status(401).json({ error: "Yelp API key is required. Please provide it in the settings." });
    }

    try {
      const response = await axiosInstance.get("https://api.yelp.com/v3/businesses/search", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        params: {
          term,
          location,
          limit: 50,
        },
      });
      res.json(response.data);
    } catch (error: any) {
      console.error("Yelp API Error:", error.response?.data || error.message);
      res.status(error.response?.status || 500).json(error.response?.data || { error: "Failed to fetch from Yelp" });
    }
  });

  // Endpoint to start a new search
  app.post('/api/search/start', async (req, res) => {
    const { params, apiConfigs } = req.body;
    
    if (!params || !apiConfigs || apiConfigs.length === 0) {
      return res.status(400).json({ error: 'Search parameters and API keys are required.' });
    }

    const jobId = `search_${Date.now()}`;
    searchJobs[jobId] = {
      id: jobId,
      status: 'running',
      progress: 'Starting search...',
      leads: [],
      startTime: Date.now(),
      params,
      stats: {
        apiCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    };

    res.json({ jobId, message: 'Search started successfully.' });

    // Run the search in the background
    runSearch(jobId, params, apiConfigs);
  });

  // Endpoint to get search status
  app.get('/api/search/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = searchJobs[jobId];
    if (job) {
      res.json(job);
    } else {
      res.status(404).json({ error: 'Search not found.' });
    }
  });

  // Endpoint to stop search
  app.post('/api/search/stop/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = searchJobs[jobId];
    if (job) {
      job.status = 'stopped';
      job.progress = 'Search stopped by user.';
      if (controllers[jobId]) {
        controllers[jobId].abort();
      }
      res.json({ message: 'Search stopped.' });
    } else {
      res.status(404).json({ error: 'Search not found.' });
    }
  });

  // Endpoint to start a new campaign
  app.post('/api/campaign/start', upload.single('sheet'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { smtps } = JSON.parse(req.body.config);
    if (!smtps || smtps.length === 0) {
      return res.status(400).json({ error: 'SMTP configurations are required.' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const leads = xlsx.utils.sheet_to_json(sheet);

    const jobId = `job_${Date.now()}`;
    jobs[jobId] = {
      id: jobId,
      status: 'running',
      total: leads.length,
      sent: 0,
      failed: 0,
      results: [],
      startTime: Date.now(),
    };

    res.json({ jobId, message: 'Campaign started successfully.' });

    // Run the campaign in the background
    runCampaign(jobId, leads, smtps);
  });

  // Endpoint to get campaign status
  app.get('/api/campaign/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];
    if (job) {
      res.json(job);
    } else {
      res.status(404).json({ error: 'Campaign not found.' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files from the dist directory in production
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

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

// Main campaign runner function
async function runCampaign(jobId: string, leads: any[], smtps: any[]) {
  const job = jobs[jobId];
  if (!job) return;
  
  let currentSmtpIndex = 0;
  const activeSmtps = smtps.map(s => ({ ...s, isInvalid: false }));

  for (const lead of leads) {
    if (job.status === 'stopped') break;

    // Normalize lead keys
    const normalizedLead: any = {};
    Object.keys(lead).forEach(k => normalizedLead[k.toUpperCase().trim()] = lead[k]);

    const targetEmail = normalizedLead.EMAIL || normalizedLead.E_MAIL || normalizedLead.MAIL || '';

    if (!targetEmail) {
      console.warn(`Skipping lead: No EMAIL column found for ${JSON.stringify(lead)}`);
      job.failed++;
      job.results.push({ 
        name: normalizedLead.NAME || 'Unknown', 
        status: 'failed', 
        error: 'No email address found in the spreadsheet.', 
        timestamp: Date.now() 
      });
      continue;
    }

    let emailSent = false;
    let attempts = 0;
    let lastError = '';

    // Try to send the email using available SMTPs in rotation
    while (!emailSent && attempts < activeSmtps.length) {
      const smtpConfig = activeSmtps[currentSmtpIndex];
      
      // Skip if this SMTP is marked as invalid or reached its limit
      const dailyLimit = smtpConfig.dailyLimit || 100;
      const sentToday = job.results.filter(
        (r: any) => r.smtpUser === smtpConfig.user && 
        r.status === 'sent' &&
        new Date(r.timestamp).toDateString() === new Date().toDateString()
      ).length;

      if (smtpConfig.isInvalid || sentToday >= dailyLimit) {
        currentSmtpIndex = (currentSmtpIndex + 1) % activeSmtps.length;
        attempts++;
        continue;
      }

      const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.port === 465,
        auth: {
          user: smtpConfig.user,
          pass: smtpConfig.pass,
        },
        connectionTimeout: 15000, 
        greetingTimeout: 10000,
        socketTimeout: 20000,
      });

      let subject = spin(normalizedLead.SUBJECT || '');
      let body = spin(normalizedLead.BODY || '');

      Object.keys(normalizedLead).forEach(key => {
        const val = String(normalizedLead[key] || '');
        const regexWithBraces = new RegExp(`{{${key}}}`, 'gi');
        subject = subject.replace(regexWithBraces, val);
        body = body.replace(regexWithBraces, val);
        const plainRegex = new RegExp(`\\b${key}\\b`, 'g'); 
        subject = subject.replace(plainRegex, val);
        body = body.replace(plainRegex, val);
      });

      // Convert newlines to <br> tags and support simple **bold** text
      const formattedBody = body
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

      const htmlBody = `
        <div style="font-family: sans-serif; line-height: 1.6; color: #333; white-space: normal;">
          ${formattedBody}
        </div>
      `;

      try {
        await transporter.sendMail({
          from: `"${smtpConfig.senderName}" <${smtpConfig.user}>`,
          to: targetEmail,
          subject: subject,
          html: htmlBody,
        });

        job.sent++;
        job.results.push({ 
          email: targetEmail, 
          status: 'sent', 
          smtpUser: smtpConfig.user, 
          timestamp: Date.now() 
        });
        emailSent = true;
        console.log(`Email successfully sent to ${targetEmail} via ${smtpConfig.user}`);
        currentSmtpIndex = (currentSmtpIndex + 1) % activeSmtps.length;
      } catch (error: any) {
        lastError = error.message;
        console.error(`SMTP Error (${smtpConfig.user} -> ${targetEmail}):`, error.message);
        
        const isAuthError = error.code === 'EAUTH' || error.responseCode === 535;
        const isConnError = error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ESOCKET';

        if (isAuthError || isConnError) {
          smtpConfig.isInvalid = true;
          console.log(`Marking SMTP ${smtpConfig.user} as invalid and rotating...`);
        }

        currentSmtpIndex = (currentSmtpIndex + 1) % activeSmtps.length;
        attempts++;
      }
    }

    if (!emailSent) {
      job.failed++;
      job.results.push({ 
        email: targetEmail, 
        status: 'failed', 
        error: lastError || 'All SMTP servers failed for this lead.', 
        timestamp: Date.now() 
      });
    }

    // Delay between leads
    const delay = activeSmtps.length > 1 ? 2000 : 10000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  job.status = 'completed';
  job.endTime = Date.now();
}

// Global controllers to manage search/campaign stops
const controllers: { [key: string]: AbortController } = {};

// Helper for runSearch
let searchRotationIndex = 0;
function getNextSearchClient(configs: any[]) {
  const activeConfigs = configs.filter(c => (c.provider === 'google' || c.provider === 'custom' || c.provider === 'openrouter') && c.isActive && c.key);
  if (activeConfigs.length === 0) throw new Error("No active API keys found.");
  
  const config = activeConfigs[searchRotationIndex % activeConfigs.length];
  searchRotationIndex++;
  
  if (config.provider === 'custom' || config.provider === 'openrouter') {
    let baseUrl = config.baseUrl;
    if (config.provider === 'openrouter' && (!baseUrl || baseUrl.includes('salesmanchatbot'))) {
      baseUrl = 'https://openrouter.ai/api/v1';
    }
    return { 
      isCustom: true, 
      config: { ...config, baseUrl } 
    };
  }

  return {
    isCustom: false,
    ai: new GoogleGenAI(config.key),
    model: config.model || "gemini-2.0-flash"
  };
}

async function callSearchLLM(prompt: string, configs: any[], systemPrompt: string = "You are a lead generation expert.", signal?: AbortSignal, jobId?: string) {
  const client = getNextSearchClient(configs);
  console.log(`[LLM] Calling ${client.isCustom ? client.config.provider : 'Gemini'} with prompt length: ${prompt.length}`);
  
  if (client.isCustom) {
    const url = `${client.config.baseUrl}/chat/completions`;
    try {
      const response = await axiosInstance.post(url, {
        model: client.config.model || "google/gemini-2.0-flash-001",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${client.config.key}`,
          'HTTP-Referer': 'https://github.com/automationhubbd24-sys/leadGenV2',
          'X-Title': 'LeadGen Pro'
        },
        signal: signal
      });

      // Update stats if jobId provided
      if (jobId && searchJobs[jobId] && response.data.usage) {
        const usage = response.data.usage;
        searchJobs[jobId].stats.apiCalls++;
        searchJobs[jobId].stats.inputTokens += (usage.prompt_tokens || 0);
        searchJobs[jobId].stats.outputTokens += (usage.completion_tokens || 0);
        searchJobs[jobId].stats.totalTokens += (usage.total_tokens || 0);
      }

      return { text: response.data.choices[0].message.content };
    } catch (error: any) {
      if (axios.isCancel(error)) throw new Error("SEARCH_STOPPED");
      console.error(`[LLM Error] ${client.config.provider}:`, error.response?.data || error.message);
      throw new Error(`AI Service Error: ${error.response?.data?.error?.message || error.message}`);
    }
  } else {
    try {
      const model = (client.ai as any).getGenerativeModel({ 
        model: client.model,
        systemInstruction: systemPrompt
      });
      // Gemini SDK doesn't support AbortSignal directly, we use a manual timeout wrapper
      const resultPromise = model.generateContent(prompt);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 45000));
      
      const result: any = await Promise.race([resultPromise, timeoutPromise]);
      
      // Update stats for Gemini
      if (jobId && searchJobs[jobId] && result.response.usageMetadata) {
        const usage = result.response.usageMetadata;
        searchJobs[jobId].stats.apiCalls++;
        searchJobs[jobId].stats.inputTokens += (usage.promptTokenCount || 0);
        searchJobs[jobId].stats.outputTokens += (usage.candidatesTokenCount || 0);
        searchJobs[jobId].stats.totalTokens += (usage.totalTokenCount || 0);
      }

      return { text: result.response.text() };
    } catch (error: any) {
      console.error(`[Gemini Error]:`, error.message);
      throw error;
    }
  }
}

async function callSearchWithTool(prompt: string, configs: any[], signal?: AbortSignal, jobId?: string) {
  const client = getNextSearchClient(configs);
  const systemPrompt = "You are an advanced business research agent. Use your search tools to find businesses and their contact details. CRITICAL: You must find the official email address for every business you find.";
  
  if (client.isCustom) {
    return await callSearchLLM(prompt, configs, systemPrompt, signal, jobId);
  } else {
    try {
      const model = (client.ai as any).getGenerativeModel({ 
        model: client.model,
        systemInstruction: systemPrompt,
        tools: [{ googleMaps: {} } as any]
      });
      const resultPromise = model.generateContent(prompt);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 60000));
      
      const result: any = await Promise.race([resultPromise, timeoutPromise]);

      // Update stats for Gemini with Tools
      if (jobId && searchJobs[jobId] && result.response.usageMetadata) {
        const usage = result.response.usageMetadata;
        searchJobs[jobId].stats.apiCalls++;
        searchJobs[jobId].stats.inputTokens += (usage.promptTokenCount || 0);
        searchJobs[jobId].stats.outputTokens += (usage.candidatesTokenCount || 0);
        searchJobs[jobId].stats.totalTokens += (usage.totalTokenCount || 0);
      }

      return { text: result.response.text() };
    } catch (error: any) {
      console.error(`[Gemini Tool Error]:`, error.message);
      throw error;
    }
  }
}

// Email Scraper using direct web request and regex (No LLM needed)
async function scrapeEmailsFromWebsite(url: string, signal?: AbortSignal) {
  if (!url || !url.startsWith('http')) return undefined;
  
  try {
    console.log(`[Scraper] Searching emails on: ${url}`);
    const response = await axiosInstance.get(url, { 
      timeout: 15000,
      signal: signal,
      headers: { 'Accept': 'text/html' }
    });
    
    const html = response.data;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = html.match(emailRegex);
    
    if (emails && emails.length > 0) {
      // Clean and deduplicate
      const uniqueEmails = [...new Set(emails.map((e: string) => e.toLowerCase()))];
      // Filter out common false positives like images or icons
      const validEmails = uniqueEmails.filter(e => !e.match(/\.(png|jpg|jpeg|gif|svg|webp)$/));
      if (validEmails.length > 0) {
        console.log(`[Scraper] Found ${validEmails.length} emails on ${url}`);
        return validEmails[0]; // Return the first valid email
      }
    }
    
    return undefined;
  } catch (err: any) {
    // Silent fail for email scraping
    return undefined;
  }
}

// Google Maps Scraper using Puppeteer
async function scrapeGoogleMaps(query: string, location: string, jobId: string, signal?: AbortSignal) {
  const job = searchJobs[jobId];
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query + " in " + location)}`;
    console.log(`[Puppeteer] Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });

    // Wait for the results list to load
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
    } catch (e) {
      console.log("[Puppeteer] Results feed not found, might be only one result or no results.");
    }

    // Auto-scroll to load more leads
    console.log("[Puppeteer] Scrolling to load leads...");
    let previousHeight = 0;
    let currentLeadsCount = 0;
    
    for (let i = 0; i < 5; i++) { // Scroll 5 times to get ~100 leads per area
      if (signal?.aborted) break;
      
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 1000);
      });
      await new Promise(r => setTimeout(resolve => setTimeout(resolve, 2000)));
    }

    // Extract lead data from the page
    const leads = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('div[role="article"]'));
      return items.map(item => {
        const name = item.querySelector('div.fontHeadlineSmall')?.textContent || '';
        const link = (item.querySelector('a.hfpxzc') as HTMLAnchorElement)?.href || '';
        const rating = item.querySelector('span.MW4etd')?.textContent || '0';
        const reviews = item.querySelector('span.UY7F9')?.textContent?.replace(/[()]/g, '') || '0';
        
        // Try to find phone and website in the sub-text
        const infoDivs = Array.from(item.querySelectorAll('div.W4Efsd'));
        let phone = '';
        let website = '';
        
        infoDivs.forEach(div => {
          const text = div.textContent || '';
          if (text.match(/\+\d+/)) phone = text;
        });

        return {
          name: name.trim(),
          phone: phone.trim(),
          website: '', // We'll get this from details or separate logic
          rating: parseFloat(rating),
          reviewCount: parseInt(reviews),
          mapsLink: link
        };
      }).filter(l => l.name.length > 0);
    });

    console.log(`[Puppeteer] Extracted ${leads.length} potential leads from page.`);
    return leads;

  } finally {
    await browser.close();
  }
}

async function runSearch(jobId: string, params: any, apiConfigs: any[]) {
  const job = searchJobs[jobId];
  if (!job) return;

  const controller = new AbortController();
  controllers[jobId] = controller;

  const { query, city, state, country } = params;
  const locationStr = `${city}${state ? `, ${state}` : ""}, ${country}`;
  const seenNames = new Set<string>();

  console.log(`[Matrix Search] Starting Puppeteer Scan for ${query} in ${locationStr}`);

  try {
    // Phase 1: Deep Neighborhood Discovery (Using LLM)
    job.progress = "শহরের প্রতিটি এলাকা খুঁজে বের করছি (Discovery)...";
    const discoveryPrompt = `List EVERY SINGLE neighborhood, business district, and suburb in "${locationStr}". 
    Format as a simple comma-separated list. Aim for at least 30-50 areas.`;
    
    const discoveryResponse = await callSearchLLM(discoveryPrompt, apiConfigs, "Geography expert.", controller.signal, jobId);
    const areasToSearch = [locationStr, ...discoveryResponse.text.split(',').map(a => a.trim())].filter(a => a.length > 2);
    
    console.log(`[Matrix Search] Found ${areasToSearch.length} areas to scan.`);

    // Phase 2: Puppeteer Matrix Scan
    for (let i = 0; i < areasToSearch.length; i++) {
      if (job.status === 'stopped' || controller.signal.aborted) break;
      
      const area = areasToSearch[i];
      job.progress = `স্ক্যান চলছে: ${area} (${i + 1}/${areasToSearch.length})`;
      console.log(`[Matrix Search] Scanning area with Puppeteer: ${area}`);

      try {
        const rawLeads = await scrapeGoogleMaps(query, area, jobId, controller.signal);
        
        for (const lead of rawLeads) {
          if (job.status === 'stopped' || controller.signal.aborted) break;
          
          const lowerName = lead.name.toLowerCase();
          if (!seenNames.has(lowerName)) {
            seenNames.add(lowerName);
            
            // For each lead, try to get website and email
            // Note: In a real production app, we'd go to the business details page to get the website
            // For now, let's add them to the list
            const newLead = {
              id: `pm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              name: lead.name,
              phone: lead.phone || "N/A",
              email: undefined, // Will be enriched if website found
              website: undefined,
              location: area,
              source: "Google Maps (Puppeteer)",
              rating: lead.rating || 0,
              reviewCount: lead.reviewCount || 0,
            };
            
            job.leads.push(newLead);
          }
        }
        
        console.log(`[Matrix Search] Total leads so far: ${job.leads.length}`);
        
        // Stop if we have enough leads
        if (job.leads.length >= 2000) break;

      } catch (err: any) {
        console.error(`[Matrix Search Error] Area ${area}:`, err.message);
      }
    }

    if (job.status !== 'stopped') {
      job.status = 'completed';
      job.progress = `অনুসন্ধান সম্পন্ন! মোট ${job.leads.length} টি লিড পাওয়া গেছে।`;
    }
  } catch (error: any) {
    if (error.message === "SEARCH_STOPPED" || controller.signal.aborted) {
      job.status = 'stopped';
      job.progress = "অনুসন্ধান থামানো হয়েছে।";
    } else {
      console.error("[Matrix Search Critical Error]:", error);
      job.status = 'failed';
      job.progress = `সার্চ চলাকালীন ত্রুটি হয়েছে: ${error.message}`;
    }
  } finally {
    delete controllers[jobId];
  }
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
