import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import multer from "multer";
import xlsx from "xlsx";
import nodemailer from "nodemailer";
import { GoogleGenAI } from "@google/genai";
import https from "https";

dotenv.config();

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

async function runSearch(jobId: string, params: any, apiConfigs: any[]) {
  const job = searchJobs[jobId];
  if (!job) return;

  const controller = new AbortController();
  controllers[jobId] = controller;

  const { query, city, state, country } = params;
  const locationStr = `${city}${state ? `, ${state}` : ""}, ${country}`;
  const seenNames = new Set<string>();

  console.log(`[Deep Search] Starting Exhaustive Scan for ${query} in ${locationStr}`);

  try {
    // Phase 1: Deep Neighborhood Discovery
    job.progress = "শহরের প্রতিটি এলাকা ও পাড়া-মহল্লা খুঁজে বের করছি (Exhaustive Discovery)...";
    const discoveryPrompt = `List EVERY SINGLE neighborhood, business district, commercial zone, and suburb in "${locationStr}". 
    I need a very long and detailed list for a deep search. Aim for at least 50-80 names. 
    Format as a simple comma-separated list of names only.`;
    
    const discoveryResponse = await callSearchLLM(discoveryPrompt, apiConfigs, "You are a local geography expert.", controller.signal, jobId);
    const areasToSearch = [locationStr, ...discoveryResponse.text.split(',').map(a => a.trim())].filter(a => a.length > 2);
    
    console.log(`[Deep Search] Found ${areasToSearch.length} sub-locations to scan.`);

    // Phase 2: Matrix Search with high concurrency
    const activeConfigs = apiConfigs.filter(c => (c.provider === 'google' || c.provider === 'custom' || c.provider === 'openrouter') && c.isActive && c.key);
    const concurrency = Math.max(3, activeConfigs.length * 2); // Scan multiple areas at once

    for (let i = 0; i < areasToSearch.length; i += concurrency) {
      if (job.status === 'stopped' || controller.signal.aborted) break;
      
      const currentBatch = areasToSearch.slice(i, i + concurrency);
      job.progress = `গভীর অনুসন্ধান চলছে: ${i + 1}/${areasToSearch.length} টি এলাকা সম্পন্ন`;
      console.log(`[Deep Search] Scanning batch: ${currentBatch.join(', ')}`);

      await Promise.all(currentBatch.map(async (area) => {
        try {
          if (job.status === 'stopped' || controller.signal.aborted) return;

          const searchPrompt = `Find ALL businesses for "${query}" in "${area}, ${country}". Use your tools. 
          Be extremely thorough. Extract name, phone, website, rating, review count, and official contact email. 
          Return ONLY a JSON array of objects. We need as many as you can find in this specific block/neighborhood.`;

          const searchResponse = await callSearchWithTool(searchPrompt, apiConfigs, controller.signal, jobId);
          const text = searchResponse.text;
          if (!text || text.length < 10) return;

          let leadsData;
          try {
            const jsonMatch = text.match(/\[.*\]/s);
            leadsData = JSON.parse(jsonMatch ? jsonMatch[0] : text);
          } catch (e) {
            // Fallback parse
            const parseResponse = await callSearchLLM(`Extract business info into JSON array: ${text.substring(0, 5000)}`, apiConfigs, "Return JSON only.", controller.signal, jobId);
            const jsonMatch = parseResponse.text.match(/\[.*\]/s);
            leadsData = JSON.parse(jsonMatch ? jsonMatch[0] : parseResponse.text);
          }

          if (Array.isArray(leadsData)) {
            leadsData.forEach((item: any) => {
              const name = String(item.name || '').trim();
              const lowerName = name.toLowerCase();
              if (name && !seenNames.has(lowerName)) {
                seenNames.add(lowerName);
                job.leads.push({
                  id: `gm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  name: name,
                  phone: item.phone || "N/A",
                  email: item.email || undefined,
                  website: item.website,
                  location: area,
                  source: "Google Maps (Deep Scan)",
                  rating: item.rating || 0,
                  reviewCount: item.reviewCount || 0,
                });
              }
            });
          }
        } catch (err: any) {
          if (err.message !== "SEARCH_STOPPED") {
            console.error(`[Deep Search Error] Area ${area}:`, err.message);
          }
        }
      }));

      // Break if we hit a massive amount of leads to prevent crashes
      if (job.leads.length >= 2000) {
        console.log("[Deep Search] Limit reached (2000 leads). Stopping.");
        break;
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
      console.error("[Deep Search Critical Error]:", error);
      job.status = 'failed';
      job.progress = `সার্চ চলাকালীন ত্রুটি হয়েছে: ${error.message}`;
    }
  } finally {
    delete controllers[jobId];
    console.log(`[Deep Search] Finished. Total leads: ${job.leads.length}`);
  }
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
