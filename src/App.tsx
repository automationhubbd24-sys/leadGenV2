import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, 
  MapPin, 
  Phone, 
  Mail, 
  Globe, 
  Download, 
  FileSpreadsheet,
  Filter, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  Building2,
  Star,
  ExternalLink,
  Plus,
  Settings,
  X,
  Key,
  UploadCloud,
  Wrench,
  Trash2,
  PlusCircle,
  Send,
  FileText,
  Clock,  
  BarChart2,
  Activity,
  Zap
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Lead, SearchParams, APIKeyConfig, LLMProvider } from './types';
import { searchGoogleMaps } from './services/geminiService';
import { searchYelp } from './services/yelpService';
import { getAllLeads, saveLeads, deleteLead, clearLeads } from './services/dbService';
import { callLLM } from './services/llmService';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function useStickyState<T>(defaultValue: T, key: string): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stickyValue = window.localStorage.getItem(key);
      if (stickyValue !== null) {
        return JSON.parse(stickyValue);
      }
    } catch (error) {
      console.error(`Error parsing localStorage key “${key}”:`, error);
      return defaultValue;
    }
    return defaultValue;
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

export default function App() {
  const [params, setParams] = useStickyState<SearchParams>({
    query: '',
    city: '',
    state: '',
    country: 'USA'
  }, 'searchParams');
  const [sources, setSources] = useState({
    google: true,
    yelp: false
  });
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<string>('');
  const [isEnriching, setIsEnriching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'api' | 'smtp' | 'database'>('api');
  const [activeTab, setActiveTab] = useStickyState<'search' | 'email'>('search', 'activeTab');

  const [apiConfigs, setApiConfigs] = useStickyState<APIKeyConfig[]>([
    { id: 'default-gemini', provider: 'google', label: 'Google AI Studio', key: '', model: 'gemini-2.5-flash', isActive: true },
    { id: 'salesman-chatbot', provider: 'custom', label: 'SalesmanChatbot', key: '', model: 'salesmanchatbot-pro', isActive: true, baseUrl: 'https://api.salesmanchatbot.online/api/external/v1' }
  ], 'apiConfigs');

  const [newConfig, setNewConfig] = useState<any>({ 
    provider: 'google', 
    model: 'gemini-2.5-flash', 
    isActive: true,
    keys: '',
    baseUrl: 'https://api.salesmanchatbot.online/api/external/v1'
  });

  const [isEnrichingAll, setIsEnrichingAll] = useState(false);
  const [lpm, setLpm] = useState(0); // Leads Per Minute
  const enrichStartTime = useRef<number | null>(null);
  const enrichedCount = useRef(0);

  // Load leads from DB on mount
  useEffect(() => {
    const loadLeads = async () => {
      const dbLeads = await getAllLeads();
      setLeads(dbLeads);
    };
    loadLeads();
  }, []);

  // Save leads to DB whenever they change
  useEffect(() => {
    if (leads.length > 0) {
      saveLeads(leads);
    }
  }, [leads]);

  // SMTP States
  const [smtps, setSmtps] = useStickyState<any[]>([], 'smtps');
  const [newSmtp, setNewSmtp] = useState({ host: 'smtp.gmail.com', port: 465, user: '', pass: '', senderName: '', dailyLimit: 100 });

  // Campaign States
  const [campaignFile, setCampaignFile] = useState<File | null>(null);
  const [campaignPreview, setCampaignPreview] = useState<any[]>([]);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [job, setJob] = useState<any>(null);
  const [isCampaignRunning, setIsCampaignRunning] = useState(false);

  // Search Job State
  const [searchJob, setSearchJob] = useStickyState<any>(null, 'searchJob');

  // Usage Stats
  const [stats, setStats] = useState({
    apiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  });

  const updateStats = (usage: any) => {
    if (!usage) return;
    setStats(prev => {
      const inputTokens = (usage.promptTokenCount || usage.prompt_tokens || 0);
      const outputTokens = (usage.candidatesTokenCount || usage.completion_tokens || 0);
      const totalTokens = (usage.totalTokenCount || usage.total_tokens || (inputTokens + outputTokens));
      
      return {
        apiCalls: prev.apiCalls + 1,
        inputTokens: prev.inputTokens + inputTokens,
        outputTokens: prev.outputTokens + outputTokens,
        totalTokens: prev.totalTokens + totalTokens
      };
    });
  };

  // Poll for campaign status
  useEffect(() => {
    if (job?.id && job.status === 'running') {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/campaign/status/${job.id}`);
          const data = await res.json();
          setJob(data);
          if (data.status === 'completed') {
            setIsCampaignRunning(false);
            clearInterval(interval);
          }
        } catch (err) {
          console.error('Polling error:', err);
          setIsCampaignRunning(false);
          clearInterval(interval);
        }
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [job]);

  // Poll for search status
  useEffect(() => {
    if (searchJob?.id && searchJob.status === 'running') {
      setIsSearching(true);
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/search/status/${searchJob.id}`);
          const data = await res.json();
          setSearchJob(data);
          
          if (data.leads && data.leads.length > 0) {
            setLeads(prev => {
              const newLeads = data.leads.filter((nl: Lead) => !prev.some(pl => pl.name === nl.name));
              return [...prev, ...newLeads];
            });
          }

          if (data.stats) {
            setStats(data.stats);
          }

          setSearchProgress(data.progress);

          if (data.status !== 'running') {
            setIsSearching(false);
            if (data.status === 'failed') {
              setError(data.progress);
            }
            setSearchProgress('');
            clearInterval(interval);
          }
        } catch (err) {
          console.error('Search polling error:', err);
          setIsSearching(false);
          clearInterval(interval);
        }
      }, 3000);
      return () => clearInterval(interval);
    } else if (searchJob?.status === 'running') {
      setIsSearching(true);
      setSearchProgress(searchJob.progress);
    }
  }, [searchJob?.id, searchJob?.status]);

  const handleAddConfig = () => {
    if (newConfig.keys) {
      const keyList = newConfig.keys.split(/[\n,]+/).map((k: string) => k.trim()).filter((k: string) => k.length > 0);
      
      const newConfigs = keyList.map((k, index) => ({
        id: `${Date.now()}-${index}`,
        provider: newConfig.provider,
        model: newConfig.model,
        label: newConfig.provider === 'google' ? 'Google AI' : (newConfig.provider === 'openrouter' ? 'OpenRouter' : 'SalesmanChatbot'),
        key: k,
        isActive: true,
        baseUrl: newConfig.baseUrl
      }));

      setApiConfigs([...apiConfigs, ...newConfigs]);
      setNewConfig({ 
        provider: newConfig.provider, 
        model: newConfig.model, 
        isActive: true,
        keys: '',
        baseUrl: newConfig.baseUrl
      });
    }
  };

  const handleDeleteConfig = (id: string) => {
    setApiConfigs(apiConfigs.filter(c => c.id !== id));
  };

  const handleToggleConfig = (id: string) => {
    setApiConfigs(apiConfigs.map(c => c.id === id ? { ...c, isActive: !c.isActive } : c));
  };

  const handleAddSmtp = () => {
    if (newSmtp.user && newSmtp.pass && newSmtp.senderName) {
      setSmtps([...smtps, { 
        ...newSmtp, 
        host: 'smtp.gmail.com', 
        port: 465, 
        id: Date.now() 
      }]);
      setNewSmtp({ host: 'smtp.gmail.com', port: 465, user: '', pass: '', senderName: '', dailyLimit: 100 });
    }
  };

  const handleDeleteSmtp = (id: number) => {
    setSmtps(smtps.filter(s => s.id !== id));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCampaignFile(file);
    setCampaignError(null);
    setCampaignPreview([]);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = event.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        
        if (json.length < 2) {
          setCampaignError('File is empty or has no data rows.');
          return;
        }

        const headers: string[] = (json[0] as any[] || []).map(h => String(h).trim().toUpperCase());
        const requiredHeaders = ['EMAIL', 'NAME', 'SUBJECT', 'BODY'];
        const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));

        if (missingHeaders.length > 0) {
          setCampaignError(`Missing required columns: ${missingHeaders.join(', ')} (Found: ${headers.join(', ') || 'none'})`);
          return;
        }

        const jsonData = XLSX.utils.sheet_to_json(sheet);
        setCampaignPreview(jsonData.slice(0, 5)); // Show preview of first 5 rows

      } catch (err) {
        setCampaignError('Invalid file format. Please upload a valid .xlsx or .csv file.');
        console.error(err);
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleStartCampaign = async () => {
    if (!campaignFile) {
      setCampaignError('Please upload a campaign sheet.');
      return;
    }
    if (smtps.length === 0) {
      setCampaignError('Please add at least one SMTP account in settings.');
      setShowSettings(true);
      return;
    }

    setIsCampaignRunning(true);
    setCampaignError(null);

    const formData = new FormData();
    formData.append('sheet', campaignFile);
    formData.append('config', JSON.stringify({ smtps }));

    try {
      const res = await fetch('/api/campaign/start', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setJob(data);
      } else {
        setCampaignError(data.error || 'Failed to start campaign.');
        setIsCampaignRunning(false);
      }
    } catch (err) {
      setCampaignError('An unexpected error occurred.');
      setIsCampaignRunning(false);
    }
  };

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    
    const q = params.query?.trim();
    const c = params.city?.trim();

    if (!q || !c) {
      setError('Please enter a business type and city.');
      return;
    }

    const searchConfigs = apiConfigs.filter(conf => (conf.provider === 'google' || conf.provider === 'custom' || conf.provider === 'openrouter') && conf.isActive && conf.key);

    if (sources.google && searchConfigs.length === 0) {
      setError('Google Maps এ সার্চ করার জন্য অন্তত একটি Gemini, SalesmanChatbot বা OpenRouter API Key প্রয়োজন।');
      setShowSettings(true);
      return;
    }

    setIsSearching(true);
    setSearchProgress('সার্চ শুরু হচ্ছে...');
    setError(null);
    setStats({ apiCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    try {
      const res = await fetch('/api/search/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { ...params, query: q, city: c }, apiConfigs })
      });
      const data = await res.json();
      if (res.ok) {
        setSearchJob(data);
      } else {
        setError(data.error || 'Failed to start search.');
        setIsSearching(false);
      }
    } catch (err: any) {
      console.error('Search error:', err);
      setError(err.message || 'An error occurred during search.');
      setIsSearching(false);
    }
  };

  const handleStopSearch = async () => {
    if (!searchJob?.id) return;
    setIsSearching(false); // UI update immediately
    setSearchProgress('Stopping search...');
    try {
      await fetch(`/api/search/stop/${searchJob.id}`, { method: 'POST' });
      setSearchJob(null); // Clear local search job
      setSearchProgress('Search stopped.');
    } catch (err) {
      console.error('Stop search error:', err);
    }
  };

  const handleClearAll = async () => {
    if (window.confirm('আপনি কি সব লিড মুছে ফেলতে চান?')) {
      await clearLeads();
      setLeads([]);
      setSearchJob(null);
    }
  };

  const enrichLead = async (leadId: string) => {
    const lead = leads.find(l => l.id === leadId);
    const activeConfigs = apiConfigs.filter(c => c.isActive && c.key);
    if (!lead || activeConfigs.length === 0) return;

    setIsEnriching(leadId);
    try {
      const prompt = `You are an expert lead researcher. Find the MOST ACCURATE official contact email for the business:
      - Name: "${lead.name}"
      - Location: "${lead.location}"
      - Website: ${lead.website || "N/A"}
      
      Instructions:
      1. Search Google, their official website, Facebook page, LinkedIn, and Yelp/YellowPages.
      2. Look for email patterns like info@, contact@, sales@, or owner's email.
      3. Return ONLY the email address if found, otherwise return "NOT_FOUND".`;

      const response = await callLLM(prompt, activeConfigs, "You are an expert lead researcher.", "text/plain", undefined, updateStats);
      const emailMatch = response.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const email = emailMatch ? emailMatch[0] : undefined;
      
      setLeads(prev => prev.map(l => l.id === leadId ? { ...l, email } : l));
    } catch (err) {
      console.error('Failed to enrich lead:', err);
    } finally {
      setIsEnriching(null);
    }
  };

  const enrichAll = async () => {
    if (isEnrichingAll) return;
    const activeConfigs = apiConfigs.filter(c => c.isActive && c.key);
    if (activeConfigs.length === 0) {
      setError('Please add and enable at least one API key first.');
      setShowSettings(true);
      return;
    }

    setIsEnrichingAll(true);
    const leadsToEnrich = leads.filter(l => !l.email);
    if (leadsToEnrich.length === 0) {
      setIsEnrichingAll(false);
      return;
    }

    enrichStartTime.current = Date.now();
    enrichedCount.current = 0;
    
    const concurrency = Math.min(activeConfigs.length * 2, 20);
    const queue = [...leadsToEnrich];
    
    const worker = async () => {
      while (queue.length > 0) {
        const lead = queue.shift();
        if (!lead) break;
        
        try {
          await enrichLead(lead.id);
          enrichedCount.current++;
          
          if (enrichStartTime.current) {
            const elapsedMins = (Date.now() - enrichStartTime.current) / 60000;
            if (elapsedMins > 0.05) {
              setLpm(Math.round(enrichedCount.current / elapsedMins));
            }
          }
        } catch (err) {
          console.error(`Worker error for lead ${lead.id}:`, err);
        }
      }
    };

    const workers = Array(concurrency).fill(null).map(() => worker());
    await Promise.all(workers);
    
    setIsEnrichingAll(false);
    setLpm(0);
  };

  const exportCSV = () => {
    const headers = ['Name', 'Phone', 'Email', 'Location', 'Source', 'Website'];
    const rows = leads.map(l => [
      l.name,
      l.phone,
      l.email || '',
      l.location,
      l.source,
      l.website || ''
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.map(v => `"${v}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `leads_${params.query}_${params.city}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportXLSX = () => {
    const data = leads.map(l => ({
      'Business Name': l.name,
      'Phone': l.phone,
      'Email': l.email || 'N/A',
      'Location': l.location,
      'Source': l.source,
      'Website': l.website || 'N/A',
      'Rating': l.rating || 'N/A',
      'Reviews': l.reviewCount || 0
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");
    XLSX.writeFile(workbook, `leads_${params.query}_${params.city}.xlsx`);
  };

  const handleOpenSettings = () => {
    setSettingsTab(activeTab === 'search' ? 'api' : 'smtp');
    setShowSettings(true);
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans">
      {/* Header */}
      <header className="bg-white border-b border-black/5 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
                <Building2 className="text-white w-5 h-5" />
              </div>
              <h1 className="text-xl font-bold tracking-tight">LeadGen Pro</h1>
            </div>
            <nav className="flex items-center gap-1 bg-[#F1F3F5] p-1 rounded-xl">
              <button 
                onClick={() => setActiveTab('search')}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                  activeTab === 'search' ? "bg-white text-black shadow-sm" : "text-black/40 hover:text-black/60"
                )}
              >
                Lead Search
              </button>
              <button 
                onClick={() => setActiveTab('email')}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                  activeTab === 'email' ? "bg-white text-black shadow-sm" : "text-black/40 hover:text-black/60"
                )}
              >
                Bulk Email
              </button>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={handleOpenSettings}
              className="p-2 hover:bg-black/5 rounded-lg transition-colors"
              title="Settings"
            >
              <Wrench className="w-5 h-5 text-black/60" />
            </button>
            {leads.length > 0 && (
              <div className="flex items-center gap-2">
                <button 
                  onClick={exportCSV}
                  className="flex items-center gap-2 px-4 py-2 bg-[#F1F3F5] text-black rounded-lg text-sm font-medium hover:bg-black/5 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  CSV
                </button>
                <button 
                  onClick={exportXLSX}
                  className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-black/80 transition-colors"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  XLSX
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Usage Stats Banner */}
        {stats.apiCalls > 0 && (
          <div className="mb-8 flex flex-wrap gap-4 items-center bg-white p-4 rounded-2xl shadow-sm border border-black/5 select-text">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#F1F3F5] rounded-xl">
              <Activity className="w-4 h-4 text-black/40" />
              <span className="text-xs font-bold uppercase tracking-wider text-black/60">API Calls:</span>
              <span className="text-sm font-mono font-bold text-black">{stats.apiCalls}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#F1F3F5] rounded-xl">
              <Zap className="w-4 h-4 text-amber-500/60" />
              <span className="text-xs font-bold uppercase tracking-wider text-black/60">Input Tokens:</span>
              <span className="text-sm font-mono font-bold text-black">{stats.inputTokens?.toLocaleString() || '0'}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#F1F3F5] rounded-xl">
              <Zap className="w-4 h-4 text-emerald-500/60" />
              <span className="text-xs font-bold uppercase tracking-wider text-black/60">Output Tokens:</span>
              <span className="text-sm font-mono font-bold text-black">{stats.outputTokens?.toLocaleString() || '0'}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-black text-white rounded-xl ml-auto">
              <BarChart2 className="w-4 h-4 text-white/60" />
              <span className="text-xs font-bold uppercase tracking-wider text-white/60">Total Tokens:</span>
              <span className="text-sm font-mono font-bold">{stats.totalTokens?.toLocaleString() || '0'}</span>
            </div>
          </div>
        )}

        {activeTab === 'search' ? (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
            {/* Sidebar Filters */}
            <aside className="lg:col-span-1 space-y-6">
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-black/5">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-black/40 mb-6">Search Parameters</h2>
                <form 
                  onSubmit={(e) => {
                    console.log('Form submitted');
                    handleSearch(e);
                  }} 
                  className="space-y-4"
                >
                  <div>
                    <label className="block text-xs font-medium text-black/60 mb-1.5 uppercase tracking-wide">Business Type</label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/30" />
                      <input 
                        type="text"
                        placeholder="e.g. Plumber, Dentist"
                        className="w-full pl-10 pr-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                        value={params.query || ''}
                        onChange={e => {
                          const val = e.target.value;
                          setParams(p => ({ ...p, query: val }));
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-black/60 mb-1.5 uppercase tracking-wide">City</label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/30" />
                      <input 
                        type="text"
                        placeholder="e.g. Los Angeles"
                        className="w-full pl-10 pr-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                        value={params.city || ''}
                        onChange={e => {
                          const val = e.target.value;
                          setParams(p => ({ ...p, city: val }));
                        }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-black/60 mb-1.5 uppercase tracking-wide">State</label>
                      <input 
                        type="text"
                        placeholder="CA"
                        className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                        value={params.state || ''}
                        onChange={e => {
                          const val = e.target.value;
                          setParams(p => ({ ...p, state: val }));
                        }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-black/60 mb-1.5 uppercase tracking-wide">Country</label>
                      <input 
                        type="text"
                        placeholder="USA"
                        className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                        value={params.country || ''}
                        onChange={e => {
                          const val = e.target.value;
                          setParams(p => ({ ...p, country: val }));
                        }}
                      />
                    </div>
                  </div>

                  <div className="pt-4 space-y-3">
                    <label className="block text-xs font-medium text-black/60 uppercase tracking-wide">Sources</label>
                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          className="w-4 h-4 rounded border-black/10 text-black focus:ring-black"
                          checked={sources.google}
                          onChange={e => setSources(s => ({ ...s, google: e.target.checked }))}
                        />
                        <span className="text-sm font-medium group-hover:text-black/70 transition-colors">Google Maps</span>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          className="w-4 h-4 rounded border-black/10 text-black focus:ring-black"
                          checked={sources.yelp}
                          onChange={e => setSources(s => ({ ...s, yelp: e.target.checked }))}
                        />
                        <span className="text-sm font-medium group-hover:text-black/70 transition-colors">Yelp (USA Only)</span>
                      </label>
                    </div>
                  </div>

                  <button 
                    type="button"
                    onClick={() => {
                      if (isSearching) {
                        handleStopSearch();
                      } else {
                        handleSearch();
                      }
                    }}
                    className={cn(
                      "w-full py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 mt-6",
                      isSearching ? "bg-red-500 hover:bg-red-600 text-white" : "bg-black text-white hover:bg-black/80 disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                  >
                    {isSearching ? (
                      <>
                        <X className="w-4 h-4" />
                        Stop Search
                      </>
                    ) : (
                      <>
                        <Search className="w-4 h-4" />
                        Find Leads
                      </>
                    )}
                  </button>
                  {leads.length > 0 && !isSearching && (
                    <button 
                      type="button"
                      onClick={handleClearAll}
                      className="w-full py-3 bg-red-50 text-red-600 rounded-xl text-sm font-bold hover:bg-red-100 transition-all flex items-center justify-center gap-2 mt-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      Clear All Results
                    </button>
                  )}
                </form>
              </div>

              {isSearching && searchProgress && (
                <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl flex items-center gap-3 animate-pulse">
                  <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
                  <p className="text-xs text-blue-700 font-bold uppercase tracking-wider">{searchProgress}</p>
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-100 p-4 rounded-xl flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                  <p className="text-xs text-red-600 font-medium leading-relaxed">{error}</p>
                </div>
              )}
            </aside>

            {/* Results Area */}
            <div className="lg:col-span-3 space-y-6">
              {leads.length > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <h2 className="text-lg font-bold">Results ({leads.length})</h2>
                    <div className="h-4 w-px bg-black/10" />
                    <button 
                      onClick={enrichAll}
                      disabled={isEnrichingAll}
                      className="text-xs font-semibold text-black/60 hover:text-black transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {isEnrichingAll ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Finding Emails...
                          {lpm > 0 && (
                            <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[10px] font-bold">
                              {lpm} LPM
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <Plus className="w-3.5 h-3.5" />
                          Enrich All Emails
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              <div className="bg-white rounded-2xl shadow-sm border border-black/5 overflow-hidden">
                {leads.length === 0 && !isSearching ? (
                  <div className="py-32 flex flex-col items-center justify-center text-center px-6">
                    <div className="w-16 h-16 bg-[#F1F3F5] rounded-full flex items-center justify-center mb-6">
                      <Building2 className="w-8 h-8 text-black/20" />
                    </div>
                    <h3 className="text-lg font-bold mb-2">No leads to display</h3>
                    <p className="text-sm text-black/40 max-w-xs">Enter your search criteria on the left to start generating leads from Maps and Yelp.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-[#F1F3F5]/50 border-b border-black/5">
                          <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-black/40">Business Name</th>
                          <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-black/40">Rating & Reviews</th>
                          <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-black/40">Contact Info</th>
                          <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-black/40">Location</th>
                          <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-black/40">Source</th>
                          <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-black/40 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/5">
                        <AnimatePresence mode="popLayout">
                          {leads.map((lead, idx) => (
                            <motion.tr 
                              key={lead.id}
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: idx * 0.05 }}
                              className="hover:bg-[#F1F3F5]/30 transition-colors group"
                            >
                              <td className="px-6 py-5">
                                <span className="text-sm font-bold text-black">{lead.name}</span>
                              </td>
                              <td className="px-6 py-5">
                                {lead.rating ? (
                                  <div className="flex flex-col gap-1">
                                    <div className="flex items-center gap-1 text-xs font-bold text-yellow-600">
                                      <Star className="w-3.5 h-3.5 fill-current" />
                                      <span>{lead.rating.toFixed(1)}</span>
                                    </div>
                                    <span className="text-[10px] font-medium text-black/40">{lead.reviewCount} reviews</span>
                                  </div>
                                ) : (
                                  <span className="text-[10px] font-medium text-black/20 italic">No ratings</span>
                                )}
                              </td>
                              <td className="px-6 py-5">
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-2 text-xs font-medium text-black/60">
                                    <Phone className="w-3.5 h-3.5" />
                                    {lead.phone}
                                  </div>
                                  <div className="flex items-center gap-2 text-xs font-medium text-black/60">
                                    <Mail className="w-3.5 h-3.5" />
                                    {lead.email ? (
                                      <span className="text-black font-semibold">{lead.email}</span>
                                    ) : (
                                      <button 
                                        onClick={() => enrichLead(lead.id)}
                                        disabled={isEnriching === lead.id}
                                        className="text-[10px] uppercase tracking-wider font-bold text-black/30 hover:text-black transition-colors"
                                      >
                                        {isEnriching === lead.id ? 'Finding...' : 'Find Email'}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-5">
                                <div className="flex items-center gap-2 text-xs font-medium text-black/60">
                                  <MapPin className="w-3.5 h-3.5" />
                                  {lead.location}
                                </div>
                              </td>
                              <td className="px-6 py-5">
                                <span className={cn(
                                  "px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                                  lead.source === 'Google Maps' ? "bg-blue-50 text-blue-600" : "bg-red-50 text-red-600"
                                )}>
                                  {lead.source}
                                </span>
                              </td>
                              <td className="px-6 py-5 text-right">
                                {lead.website && (
                                  <a 
                                    href={lead.website} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-black/5 transition-colors"
                                  >
                                    <ExternalLink className="w-4 h-4 text-black/40" />
                                  </a>
                                )}
                              </td>
                            </motion.tr>
                          ))}
                        </AnimatePresence>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <BulkEmailUI
            job={job}
            isCampaignRunning={isCampaignRunning}
            campaignFile={campaignFile}
            campaignPreview={campaignPreview}
            campaignError={campaignError}
            fileInputRef={fileInputRef}
            handleFileChange={handleFileChange}
            handleStartCampaign={handleStartCampaign}
          />
        )}
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="p-6 border-b border-black/5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => setSettingsTab('api')}
                    className={cn(
                      "text-sm font-bold pb-1 border-b-2 transition-all",
                      settingsTab === 'api' ? "border-black text-black" : "border-transparent text-black/40"
                    )}
                  >
                    Lead Search APIs
                  </button>
                  <button 
                    onClick={() => setSettingsTab('smtp')}
                    className={cn(
                      "text-sm font-bold pb-1 border-b-2 transition-all",
                      settingsTab === 'smtp' ? "border-black text-black" : "border-transparent text-black/40"
                    )}
                  >
                    Bulk Email SMTPs
                  </button>
                  <button 
                    onClick={() => setSettingsTab('database')}
                    className={cn(
                      "text-sm font-bold pb-1 border-b-2 transition-all",
                      settingsTab === 'database' ? "border-black text-black" : "border-transparent text-black/40"
                    )}
                  >
                    Database
                  </button>
                </div>
                <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-black/5 rounded-lg">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
                {settingsTab === 'api' ? (
                  <div className="space-y-6">
                    <div className="space-y-4">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-black/40">Active API Keys</h3>
                      <div className="space-y-2">
                        {apiConfigs.map(config => (
                          <div key={config.id} className="flex items-center gap-4 p-4 bg-[#F1F3F5]/50 border border-black/5 rounded-2xl group">
                            <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center shadow-sm">
                              <Key className={cn("w-5 h-5", config.isActive ? "text-green-500" : "text-black/20")} />
                            </div>
                            <div className="flex-grow">
                              <p className="font-bold text-sm">{config.label} <span className="text-xs font-medium text-black/40">({config.provider})</span></p>
                              <p className="text-[10px] font-bold text-black/30 uppercase tracking-widest mt-0.5">Model: {config.model || 'N/A'}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={() => handleToggleConfig(config.id)}
                                className={cn(
                                  "px-3 py-1 rounded-lg text-[10px] font-bold uppercase transition-all",
                                  config.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                                )}
                              >
                                {config.isActive ? 'Active' : 'Disabled'}
                              </button>
                              <button 
                                onClick={() => handleDeleteConfig(config.id)} 
                                className="p-2 text-red-500 hover:bg-red-50 rounded-xl transition-colors opacity-0 group-hover:opacity-100"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-6 border border-dashed border-black/10 rounded-2xl space-y-6">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-black/40">Add New Provider</h4>
                      <div className="grid grid-cols-1 gap-4">
                        <div>
                          <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">Provider</label>
                          <select 
                            className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                            value={newConfig.provider}
                            onChange={e => {
                              const p = e.target.value as LLMProvider;
                              let m = 'gemini-2.5-flash';
                              if (p === 'custom') m = 'salesmanchatbot-pro';
                              if (p === 'openrouter') m = 'google/gemini-2.5-flash';
                              setNewConfig(c => ({ ...c, provider: p, model: m }));
                            }}
                          >
                            <option value="google">Google AI Studio (Gemini)</option>
                            <option value="custom">SalesmanChatbot (Branded)</option>
                            <option value="openrouter">OpenRouter (Gemini/Any)</option>
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-4">
                        <div>
                          <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">API Key</label>
                          <input 
                            type="password"
                            placeholder="Paste your key here..."
                            className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all font-mono"
                            value={newConfig.keys || ''}
                            onChange={e => setNewConfig(c => ({ ...c, keys: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">Model ID</label>
                          <input 
                            type="text"
                            placeholder="e.g. salesmanchatbot-pro"
                            className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                            value={newConfig.model || ''}
                            onChange={e => setNewConfig(c => ({ ...c, model: e.target.value }))}
                          />
                        </div>
                        {newConfig.provider === 'custom' && (
                          <div>
                            <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">Base URL (Optional)</label>
                            <input 
                              type="text"
                              placeholder="https://api.salesmanchatbot.online/api/external/v1"
                              className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                              value={newConfig.baseUrl || ''}
                              onChange={e => setNewConfig(c => ({ ...c, baseUrl: e.target.value }))}
                            />
                          </div>
                        )}
                      </div>
                      <button 
                        onClick={handleAddConfig} 
                        className="w-full py-3 bg-black text-white rounded-xl text-sm font-bold hover:bg-black/80 transition-all flex items-center justify-center gap-2"
                      >
                        <PlusCircle className="w-4 h-4" />
                        Add Provider Configuration
                      </button>
                    </div>
                  </div>
                ) : settingsTab === 'smtp' ? (
                  <div className="space-y-6">
                    <div className="space-y-4">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-black/40">Active SMTP Accounts</h3>
                      <div className="space-y-2">
                        {smtps.map(smtp => (
                          <div key={smtp.id} className="flex items-center gap-4 p-4 bg-[#F1F3F5]/50 border border-black/5 rounded-2xl group">
                            <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center shadow-sm">
                              <Mail className="w-5 h-5 text-black/40" />
                            </div>
                            <div className="flex-grow">
                              <p className="font-bold text-sm">{smtp.senderName} <span className="text-xs font-medium text-black/40">({smtp.user})</span></p>
                              <p className="text-[10px] font-bold text-black/30 uppercase tracking-widest mt-0.5">Host: {smtp.host}:{smtp.port} | Limit: {smtp.dailyLimit}</p>
                            </div>
                            <button 
                              onClick={() => handleDeleteSmtp(smtp.id)} 
                              className="p-2 text-red-500 hover:bg-red-50 rounded-xl transition-colors opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                        {smtps.length === 0 && (
                          <div className="text-center py-12 bg-[#F1F3F5]/30 rounded-2xl border border-dashed border-black/10">
                            <Mail className="w-8 h-8 text-black/10 mx-auto mb-3" />
                            <p className="text-sm font-semibold text-black/40">No SMTP accounts added.</p>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="p-6 border border-dashed border-black/10 rounded-2xl space-y-6">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-black/40">Add New Account</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">Sender Name</label>
                          <input 
                            type="text"
                            placeholder="e.g. Alex"
                            className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                            value={newSmtp.senderName}
                            onChange={e => setNewSmtp(s => ({ ...s, senderName: e.target.value }))}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">Gmail Address</label>
                          <input 
                            type="email"
                            placeholder="your-email@gmail.com"
                            className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                            value={newSmtp.user}
                            onChange={e => setNewSmtp(s => ({ ...s, user: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">App Password</label>
                          <input 
                            type="password"
                            placeholder="Enter 16-character App Password"
                            className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                            value={newSmtp.pass}
                            onChange={e => setNewSmtp(s => ({ ...s, pass: e.target.value }))}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-black/40 mb-1.5 uppercase tracking-wider">Daily Limit</label>
                          <input 
                            type="number"
                            placeholder="100"
                            className="w-full px-4 py-2.5 bg-[#F1F3F5] border-none rounded-xl text-sm focus:ring-2 focus:ring-black/5 transition-all"
                            value={newSmtp.dailyLimit}
                            onChange={e => setNewSmtp(s => ({ ...s, dailyLimit: parseInt(e.target.value) || 0 }))}
                          />
                        </div>
                      </div>
                      <button 
                        onClick={handleAddSmtp} 
                        className="w-full py-3 bg-black text-white rounded-xl text-sm font-bold hover:bg-black/80 transition-all flex items-center justify-center gap-2"
                      >
                        <PlusCircle className="w-4 h-4" />
                        Add Gmail Account
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="bg-amber-50 p-6 rounded-2xl border border-amber-100">
                      <div className="flex items-center gap-3 mb-4">
                        <AlertCircle className="w-5 h-5 text-amber-600" />
                        <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wider">Database Management</h3>
                      </div>
                      <p className="text-xs text-amber-700 leading-relaxed mb-6">
                        Your leads are stored locally in your browser's IndexedDB. This ensures that your data is safe even if you close the tab or lose internet connection.
                      </p>
                      
                      <div className="flex flex-col gap-3">
                        <button 
                          onClick={async () => {
                            if (confirm('Are you sure you want to clear ALL leads from the local database? This cannot be undone.')) {
                              await clearLeads();
                              setLeads([]);
                            }
                          }}
                          className="flex items-center justify-center gap-2 py-3 bg-red-50 text-red-600 rounded-xl text-xs font-bold hover:bg-red-100 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                          CLEAR ALL DATA
                        </button>
                        <button 
                          onClick={() => {
                            const data = JSON.stringify(leads, null, 2);
                            const blob = new Blob([data], { type: 'application/json' });
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.href = url;
                            link.download = `leadgen_backup_${new Date().toISOString().split('T')[0]}.json`;
                            link.click();
                          }}
                          className="flex items-center justify-center gap-2 py-3 bg-black text-white rounded-xl text-xs font-bold hover:bg-black/80 transition-all"
                        >
                          <Download className="w-4 h-4" />
                          DOWNLOAD BACKUP (JSON)
                        </button>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 bg-[#F1F3F5] rounded-2xl text-center">
                        <p className="text-[10px] font-bold text-black/40 uppercase tracking-widest mb-1">Total Leads</p>
                        <p className="text-2xl font-black">{leads.length}</p>
                      </div>
                      <div className="p-4 bg-[#F1F3F5] rounded-2xl text-center">
                        <p className="text-[10px] font-bold text-black/40 uppercase tracking-widest mb-1">Storage Type</p>
                        <p className="text-sm font-black uppercase">IndexedDB</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-12 border-t border-black/5 mt-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2 opacity-40">
            <Building2 className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-widest">LeadGen Pro v1.0</span>
          </div>
          <div className="flex items-center gap-8">
            <a href="#" className="text-xs font-bold uppercase tracking-widest text-black/40 hover:text-black transition-colors">Documentation</a>
            <a href="#" className="text-xs font-bold uppercase tracking-widest text-black/40 hover:text-black transition-colors">API Status</a>
            <a href="#" className="text-xs font-bold uppercase tracking-widest text-black/40 hover:text-black transition-colors">Privacy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function BulkEmailUI({ job, isCampaignRunning, campaignFile, campaignPreview, campaignError, fileInputRef, handleFileChange, handleStartCampaign }: any) {
  const progress = job ? (job.sent + job.failed) / job.total * 100 : 0;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
        
        {/* Left Column: Campaign Launcher */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-black/5 space-y-6">
          <h2 className="text-lg font-bold flex items-center gap-2"><span className="bg-black text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">1</span> Launch New Campaign</h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-black/60 uppercase tracking-wide mb-2">Upload Spreadsheet</label>
              <div 
                className="border-2 border-dashed border-black/10 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-black/5 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadCloud className="w-8 h-8 text-black/30 mb-2" />
                <p className="font-semibold text-sm">{campaignFile ? campaignFile.name : 'Click to upload a .xlsx or .csv file'}</p>
              </div>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept=".xlsx, .csv" />
            </div>

            {campaignError && (
              <div className="bg-red-50 text-red-700 text-xs font-semibold p-3 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                {campaignError}
              </div>
            )}

            {campaignPreview.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase text-black/40">Data Preview (First 5 Rows)</h3>
                <div className="overflow-x-auto rounded-lg border border-black/5">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        {Object.keys(campaignPreview[0]).map(key => (
                          <th key={key} className="px-4 py-2 text-left font-semibold">{key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {campaignPreview.map((row, i) => (
                        <tr key={i}>
                          {Object.values(row).map((val: any, j) => (
                            <td key={j} className="px-4 py-2 whitespace-nowrap truncate max-w-xs">{String(val)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <button 
            onClick={handleStartCampaign}
            disabled={isCampaignRunning || !campaignFile || !!campaignError || campaignPreview.length === 0}
            className="w-full py-3 bg-black text-white rounded-xl text-sm font-bold hover:bg-black/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {isCampaignRunning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Campaign Running...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Start Campaign
              </>
            )}
          </button>
        </div>

        {/* Right Column: Campaign Status */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-black/5 space-y-4">
          <h2 className="text-lg font-bold flex items-center gap-2"><span className="bg-black text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">2</span> Campaign Status</h2>
          {job ? (
            <div className="space-y-4">
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style={{ width: `${progress}%` }}></div>
              </div>
              <div className="grid grid-cols-3 divide-x divide-gray-200 text-center">
                <div>
                  <p className="font-bold text-2xl">{job.sent}</p>
                  <p className="text-xs text-gray-500">Sent</p>
                </div>
                <div>
                  <p className="font-bold text-2xl text-red-500">{job.failed}</p>
                  <p className="text-xs text-gray-500">Failed</p>
                </div>
                <div>
                  <p className="font-bold text-2xl">{job.total}</p>
                  <p className="text-xs text-gray-500">Total</p>
                </div>
              </div>
              <div className="text-xs text-center text-gray-500">
                Status: <span className="font-bold uppercase">{job.status}</span>
              </div>

              {job.results && job.results.filter((r: any) => r.status === 'failed').length > 0 && (
                <div className="mt-4 space-y-2">
                  <h3 className="text-xs font-bold uppercase text-red-500 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    Failed Leads Details
                  </h3>
                  <div className="max-h-40 overflow-y-auto border border-red-100 rounded-lg bg-red-50/30 p-2 space-y-1">
                    {job.results.filter((r: any) => r.status === 'failed').map((res: any, i: number) => (
                      <div key={i} className="text-[10px] flex flex-col border-b border-red-100 pb-1 last:border-0">
                        <span className="font-bold text-red-700">{res.email || res.name || 'Unknown Lead'}</span>
                        <span className="text-red-500/70 truncate">{res.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-10 flex flex-col items-center">
              <BarChart2 className="w-10 h-10 text-black/10 mb-4" />
              <p className="text-sm font-semibold text-black/40">No active campaign.</p>
              <p className="text-xs text-black/30">Upload a sheet to start.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
