import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import multer from "multer";
import xlsx from "xlsx";
import nodemailer from "nodemailer";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

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
      const response = await axios.get("https://api.yelp.com/v3/businesses/search", {
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
  let currentSmtpIndex = 0;
  const activeSmtps = smtps.map(s => ({ ...s, isInvalid: false }));

  for (const lead of leads) {
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

async function callSearchLLM(prompt: string, configs: any[], systemPrompt: string = "You are a lead generation expert. Your goal is to find businesses and their official contact information, especially emails.") {
  const client = getNextSearchClient(configs);
  if (client.isCustom) {
    const url = `${client.config.baseUrl}/chat/completions`;
    try {
      const response = await axios.post(url, {
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
        timeout: 60000
      });
      return { text: response.data.choices[0].message.content };
    } catch (error: any) {
      console.error(`LLM Call Error (${client.config.provider}):`, error.response?.data || error.message);
      throw new Error(`AI Service Error: ${error.response?.data?.error?.message || error.message}`);
    }
  } else {
    // Correct way to use @google/genai SDK
    try {
      const model = (client.ai as any).getGenerativeModel({ 
        model: client.model,
        systemInstruction: systemPrompt
      });
      const result = await model.generateContent(prompt);
      return { text: result.response.text() };
    } catch (error: any) {
      console.error(`Gemini Error:`, error.message);
      throw error;
    }
  }
}

async function callSearchWithTool(prompt: string, configs: any[]) {
  const client = getNextSearchClient(configs);
  const systemPrompt = "You are an advanced business research agent. Use your search tools to find businesses and their contact details. CRITICAL: You must find the official email address for every business you find. Search their websites, social media, or public records to find it. Do not just say 'N/A' if you can find it.";
  
  if (client.isCustom) {
    return await callSearchLLM(prompt, configs, systemPrompt);
  } else {
    // Correct way to use @google/genai SDK with tools
    const model = (client.ai as any).getGenerativeModel({ 
      model: client.model,
      systemInstruction: systemPrompt,
      tools: [{ googleMaps: {} } as any]
    });
    const result = await model.generateContent(prompt);
    return { text: result.response.text() };
  }
}

async function runSearch(jobId: string, params: any, apiConfigs: any[]) {
  const job = searchJobs[jobId];
  const { query, city, state, country } = params;
  const locationStr = `${city}${state ? `, ${state}` : ""}, ${country}`;
  const seenNames = new Set<string>();

  try {
    job.progress = "বিজনেসের ধরন বিশ্লেষণ করছি...";
    const keywordPrompt = `For the business type "${query}" in "${country}", list 10 most common alternative categories, synonyms, or related sub-sectors used on Google Maps. Format as a simple comma-separated list.`;
    const keywordResponse = await callSearchLLM(keywordPrompt, apiConfigs);
    const keywords = [query, ...keywordResponse.text.split(',').map(k => k.trim())].slice(0, 10);

    job.progress = "শহরের প্রতিটি এলাকা (Neighborhoods) খুঁজে বের করছি...";
    const discoveryPrompt = `List every single major and minor neighborhood, commercial hub, and business district in "${locationStr}". Include at least 40-50 areas if possible. Format as a comma-separated list.`;
    const discoveryResponse = await callSearchLLM(discoveryPrompt, apiConfigs);
    const areasToSearch = [locationStr, ...discoveryResponse.text.split(',').map(a => a.trim())].slice(0, 40);

    const activeConfigs = apiConfigs.filter(c => (c.provider === 'google' || c.provider === 'custom') && c.isActive && c.key);
    const concurrency = Math.max(2, activeConfigs.length);

    for (let i = 0; i < areasToSearch.length; i++) {
      if (job.status === 'stopped') break;
      const area = areasToSearch[i];
      job.progress = `অনুসন্ধান চলছে: ${area} (${i + 1}/${areasToSearch.length})`;
      
      for (let j = 0; j < keywords.length; j += concurrency) {
        if (job.status === 'stopped') break;
        const currentKeywords = keywords.slice(j, j + concurrency);
        
        await Promise.all(currentKeywords.map(async (keyword) => {
          try {
            const searchPrompt = `Find EVERY SINGLE business for "${keyword}" in "${area}, ${country}". You MUST use your search tools. Be extremely exhaustive. For each business, extract: name, phone, website, rating, and review count. CRITICAL: Also find the official contact email for each business. If you cannot find it directly on Google Maps, use your search tools to check their website or social media pages.`;
            const searchResponse = await callSearchWithTool(searchPrompt, apiConfigs);
            const text = searchResponse.text;
            if (!text || text.length < 10) return;

            const parsePrompt = `Extract business info into a JSON array of objects (keys: name, phone, email, website, rating, reviewCount) from: ${text}. Return ONLY valid JSON. Capture any mentioned email in the 'email' field. If no email is found, use null.`;
            const parseResponse = await callSearchLLM(parsePrompt, apiConfigs, "Extract business info into valid JSON array.");
            
            let leadsData;
            try {
              const jsonMatch = parseResponse.text.match(/\[.*\]/s);
              leadsData = JSON.parse(jsonMatch ? jsonMatch[0] : parseResponse.text);
            } catch (e) { return; }

            leadsData.forEach((item: any) => {
              const lowerName = item.name.toLowerCase();
              if (!seenNames.has(lowerName)) {
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
          } catch (err) { console.error("Batch search error:", err.message); }
        }));
      }
    }
    job.status = job.status === 'stopped' ? 'stopped' : 'completed';
    job.progress = job.status === 'completed' ? "অনুসন্ধান সম্পন্ন হয়েছে।" : "অনুসন্ধান থামানো হয়েছে।";
  } catch (error: any) {
    console.error("Search Runner Error:", error);
    job.status = 'failed';
    job.progress = `ত্রুটি: ${error.message}`;
  }
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
