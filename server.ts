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
      params
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
    // ... existing lead processing ...
  }
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

async function callSearchLLM(prompt: string, configs: any[], systemPrompt: string = "You are a lead generation expert.", signal?: AbortSignal) {
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
      return { text: result.response.text() };
    } catch (error: any) {
      console.error(`[Gemini Error]:`, error.message);
      throw error;
    }
  }
}

async function callSearchWithTool(prompt: string, configs: any[], signal?: AbortSignal) {
  const client = getNextSearchClient(configs);
  const systemPrompt = "You are an advanced business research agent. Use your search tools to find businesses and their contact details. CRITICAL: You must find the official email address for every business you find.";
  
  if (client.isCustom) {
    return await callSearchLLM(prompt, configs, systemPrompt, signal);
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

  console.log(`[Search] Starting job ${jobId} for ${query} in ${locationStr}`);

  try {
    job.progress = "বিজনেসের ধরন বিশ্লেষণ করছি...";
    const keywordPrompt = `For the business type "${query}" in "${country}", list 10 most common alternative categories, synonyms, or related sub-sectors used on Google Maps. Format as a simple comma-separated list.`;
    
    const keywordResponse = await callSearchLLM(keywordPrompt, apiConfigs, "You are a lead generation expert.", controller.signal);
    const keywords = [query, ...keywordResponse.text.split(',').map(k => k.trim())].slice(0, 10);
    console.log(`[Search] Keywords generated: ${keywords.join(', ')}`);

    job.progress = "শহরের প্রতিটি এলাকা (Neighborhoods) খুঁজে বের করছি...";
    const discoveryPrompt = `List every single major and minor neighborhood, commercial hub, and business district in "${locationStr}". Include at least 40-50 areas if possible. Format as a comma-separated list.`;
    
    const discoveryResponse = await callSearchLLM(discoveryPrompt, apiConfigs, "You are a lead generation expert.", controller.signal);
    const areasToSearch = [locationStr, ...discoveryResponse.text.split(',').map(a => a.trim())].slice(0, 40);
    console.log(`[Search] Areas discovered: ${areasToSearch.length}`);

    const activeConfigs = apiConfigs.filter(c => (c.provider === 'google' || c.provider === 'custom') && c.isActive && c.key);
    const concurrency = Math.max(2, activeConfigs.length);

    for (let i = 0; i < areasToSearch.length; i++) {
      if (job.status === 'stopped' || controller.signal.aborted) break;
      
      const area = areasToSearch[i];
      job.progress = `অনুসন্ধান চলছে: ${area} (${i + 1}/${areasToSearch.length})`;
      console.log(`[Search] Processing area: ${area}`);
      
      for (let j = 0; j < keywords.length; j += concurrency) {
        if (job.status === 'stopped' || controller.signal.aborted) break;
        
        const currentKeywords = keywords.slice(j, j + concurrency);
        console.log(`[Search] Batch keywords: ${currentKeywords.join(', ')}`);
        
        // Use Promise.all with individual error handling to prevent one hang from stopping everything
        await Promise.all(currentKeywords.map(async (keyword) => {
          try {
            if (job.status === 'stopped' || controller.signal.aborted) return;
            
            const searchPrompt = `Find EVERY SINGLE business for "${keyword}" in "${area}, ${country}". You MUST use your search tools. Be extremely exhaustive. For each business, extract: name, phone, website, rating, and review count. CRITICAL: Also find the official contact email for each business.`;
            const searchResponse = await callSearchWithTool(searchPrompt, apiConfigs, controller.signal);
            const text = searchResponse.text;
            if (!text || text.length < 10) return;

            const parsePrompt = `Extract business info into a JSON array of objects (keys: name, phone, email, website, rating, reviewCount) from: ${text}. Return ONLY valid JSON.`;
            const parseResponse = await callSearchLLM(parsePrompt, apiConfigs, "Extract business info into valid JSON array.", controller.signal);
            
            let leadsData;
            try {
              const jsonMatch = parseResponse.text.match(/\[.*\]/s);
              leadsData = JSON.parse(jsonMatch ? jsonMatch[0] : parseResponse.text);
            } catch (e) { 
              console.error(`[Search] JSON parse error for ${keyword} in ${area}`);
              return; 
            }

            if (Array.isArray(leadsData)) {
              leadsData.forEach((item: any) => {
                const lowerName = String(item.name || '').toLowerCase();
                if (lowerName && !seenNames.has(lowerName)) {
                  seenNames.add(lowerName);
                  job.leads.push({
                    id: `gm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    name: item.name,
                    phone: item.phone || "N/A",
                    email: item.email || undefined,
                    website: item.website,
                    location: area,
                    source: "Google Maps",
                    rating: item.rating || 0,
                    reviewCount: item.reviewCount || 0,
                  });
                }
              });
            }
          } catch (err: any) { 
            if (err.message !== "SEARCH_STOPPED") {
              console.error(`[Search Batch Error] ${keyword} in ${area}:`, err.message);
            }
          }
        }));
      }
    }
    
    if (job.status !== 'stopped') {
      job.status = 'completed';
      job.progress = "অনুসন্ধান সম্পন্ন হয়েছে।";
    }
  } catch (error: any) {
    if (error.message === "SEARCH_STOPPED") {
      job.status = 'stopped';
      job.progress = "অনুসন্ধান থামানো হয়েছে।";
    } else {
      console.error("[Search Critical Error]:", error);
      job.status = 'failed';
      job.progress = `সার্চ চলাকালীন ত্রুটি হয়েছে: ${error.message}`;
    }
  } finally {
    delete controllers[jobId];
    console.log(`[Search] Job ${jobId} finished with status: ${job.status}, leads: ${job.leads.length}`);
  }
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
