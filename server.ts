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
    const distPath = path.join(process.cwd(), "dist");
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
  let smtpIndex = 0;

  for (const lead of leads) {
    const smtpConfig = smtps[smtpIndex];
    const dailyLimit = smtpConfig.dailyLimit || 100; // Default limit

    // Check daily limit for this SMTP
    const sentToday = job.results.filter(
      (r: any) => r.smtpUser === smtpConfig.user && new Date(r.timestamp).toDateString() === new Date().toDateString()
    ).length;

    if (sentToday >= dailyLimit) {
      // Move to next SMTP if limit reached
      smtpIndex = (smtpIndex + 1) % smtps.length;
      continue; // In a real scenario, you might want to requeue this lead
    }

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      },
    });

    // Process spintax and personalization
    let subject = spin(lead.SUBJECT || '');
    let body = spin(lead.BODY || '');

    Object.keys(lead).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      subject = subject.replace(regex, lead[key]);
      body = body.replace(regex, lead[key]);
    });

    try {
      await transporter.sendMail({
        from: `"${smtpConfig.senderName}" <${smtpConfig.user}>`,
        to: lead.EMAIL,
        subject: subject,
        html: body,
      });

      job.sent++;
      job.results.push({ email: lead.EMAIL, status: 'sent', smtpUser: smtpConfig.user, timestamp: Date.now() });
    } catch (error: any) {
      job.failed++;
      job.results.push({ email: lead.EMAIL, status: 'failed', error: error.message, smtpUser: smtpConfig.user, timestamp: Date.now() });
    }

    // Rotate to the next SMTP server
    smtpIndex = (smtpIndex + 1) % smtps.length;

    // Adaptive delay
    const delay = smtps.length > 1 ? 2000 : 10000; // 2s for multi, 10s for single
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  job.status = 'completed';
  job.endTime = Date.now();
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
