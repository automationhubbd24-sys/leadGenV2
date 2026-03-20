import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import multer from "multer";
import xlsx from "xlsx";
import nodemailer from "nodemailer";

dotenv.config();

// Setup for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// In-memory job store
const jobs: { [key: string]: any } = {};

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

      const htmlBody = body.replace(/\n/g, '<br>');

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

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
