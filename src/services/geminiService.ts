import { GoogleGenAI, Type } from "@google/genai";
import { Lead, SearchParams, APIKeyConfig } from "../types";

let geminiRotationIndex = 0;

function getNextGeminiClient(configs: APIKeyConfig[]) {
  const activeConfigs = configs.filter(c => (c.provider === 'google' || c.provider === 'custom' || c.provider === 'openrouter') && c.isActive && c.key);
  if (activeConfigs.length === 0) throw new Error("No active API keys found.");
  
  const config = activeConfigs[geminiRotationIndex % activeConfigs.length];
  geminiRotationIndex++;
  
  if (config.provider === 'custom' || config.provider === 'openrouter') {
    return {
      isCustom: true,
      config: config
    };
  }

  return {
    isCustom: false,
    ai: new GoogleGenAI({ apiKey: config.key }),
    model: config.model || "gemini-2.5-flash"
  };
}

export async function searchGoogleMaps(
  params: SearchParams,
  apiConfigs: APIKeyConfig[],
  onBatchUpdate?: (newLeads: Lead[]) => void,
  onProgress?: (message: string) => void,
  onUsageUpdate?: (usage: any) => void
): Promise<Lead[]> {
  const { query, city, state, country } = params;
  const locationStr = `${city}${state ? `, ${state}` : ""}, ${country}`;

  const allLeads: Lead[] = [];
  const seenNames = new Set<string>();

  const callSearchLLM = async (prompt: string, configs: APIKeyConfig[], systemPrompt: string = "") => {
    const client = getNextGeminiClient(configs);
    if (client.isCustom) {
      const { callLLM } = await import('./llmService');
      const response = await callLLM(prompt, [client.config!], systemPrompt, "text/plain", undefined, onUsageUpdate);
      return { text: response };
    } else {
      const response = await client.ai!.models.generateContent({
        model: client.model!,
        contents: prompt,
        config: systemPrompt ? { systemInstruction: systemPrompt } as any : undefined
      });
      onUsageUpdate?.(response.usageMetadata);
      return { text: response.text };
    }
  };

  const callSearchWithTool = async (prompt: string, configs: APIKeyConfig[]) => {
    const client = getNextGeminiClient(configs);
    if (client.isCustom) {
      const { callLLM } = await import('./llmService');
      const response = await callLLM(prompt, [client.config!], "You must use your internal search tools if available.", "text/plain", undefined, onUsageUpdate);
      return { text: response };
    } else {
      const response = await client.ai!.models.generateContent({
        model: client.model!,
        contents: prompt,
        config: { tools: [{ googleMaps: {} } as any] },
      });
      onUsageUpdate?.(response.usageMetadata);
      return { text: response.text };
    }
  };

  try {
    onProgress?.("বিজনেসের ধরন বিশ্লেষণ করছি...");
    const keywordPrompt = `For the business type "${query}" in "${country}", list 10 most common alternative categories, synonyms, or related sub-sectors used on Google Maps. 
    If the country is not an English-speaking one, also include terms in the local language (e.g. for Bangladesh, include Bengali terms).
    Format as a simple comma-separated list.`;
    
    const keywordResponse = await callSearchLLM(keywordPrompt, apiConfigs);
    const keywords = [query, ...keywordResponse.text.split(',').map(k => k.trim())].slice(0, 10);

    onProgress?.("শহরের প্রতিটি এলাকা (Neighborhoods) খুঁজে বের করছি...");
    const discoveryPrompt = `List every single major and minor neighborhood, commercial hub, and business district in "${locationStr}". 
    I need an exhaustive list for a deep scan. Include at least 40-50 areas if possible. Format as a comma-separated list.`;
    
    const discoveryResponse = await callSearchLLM(discoveryPrompt, apiConfigs);
    const discoveredAreas = discoveryResponse.text.split(',').map(a => a.trim()).filter(a => a.length > 0);
    const areasToSearch = [locationStr, ...discoveredAreas].slice(0, 40);

    onProgress?.(`মোট ${areasToSearch.length} টি এলাকায় গভীর অনুসন্ধান শুরু করছি...`);

    const activeConfigs = apiConfigs.filter(c => (c.provider === 'google' || c.provider === 'custom') && c.isActive && c.key);
    const concurrency = Math.max(2, activeConfigs.length);

    for (let i = 0; i < areasToSearch.length; i++) {
      const area = areasToSearch[i];
      onProgress?.(`অনুসন্ধান চলছে: ${area} (${i + 1}/${areasToSearch.length})`);
      
      for (let j = 0; j < keywords.length; j += concurrency) {
        const currentKeywords = keywords.slice(j, j + concurrency);
        
        const batchPromises = currentKeywords.map(async (keyword) => {
          try {
            const searchPrompt = `Find EVERY SINGLE business for "${keyword}" in "${area}, ${country}". 
            You MUST use your search tools. Be extremely exhaustive. 
            For each business, extract: name, phone, website, rating, and review count.
            CRITICAL: Also find the official contact email for each business. Use the website or your internal knowledge to provide the most accurate email.`;

            const searchResponse = await callSearchWithTool(searchPrompt, apiConfigs);
            const text = searchResponse.text;
            if (!text || text.length < 10) return;
            
            const parsePrompt = `Extract business info into a JSON array of objects (keys: name, phone, email, website, rating, reviewCount) from: ${text}. Return ONLY valid JSON. If email is not found, use null.`;
            const parseResponse = await callSearchLLM(parsePrompt, apiConfigs, "Extract business info into valid JSON array.");
            
            let leadsData;
            try {
              const jsonMatch = parseResponse.text.match(/\[.*\]/s);
              leadsData = JSON.parse(jsonMatch ? jsonMatch[0] : parseResponse.text);
            } catch (e) {
              console.error("JSON Parse Error:", e);
              return;
            }

            const batchLeads: Lead[] = [];
            leadsData.forEach((item: any) => {
              const lowerName = item.name.toLowerCase();
              if (!seenNames.has(lowerName)) {
                seenNames.add(lowerName);
                
                const newLead: Lead = {
                  id: `gm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  name: item.name,
                  phone: item.phone || "N/A",
                  email: item.email || undefined,
                  website: item.website,
                  location: area,
                  source: "Google Maps",
                  rating: item.rating || 0,
                  reviewCount: item.reviewCount || 0,
                };

                batchLeads.push(newLead);
                allLeads.push(newLead);
              }
            });

            if (onBatchUpdate && batchLeads.length > 0) {
              onBatchUpdate(batchLeads);
            }
          } catch (err) {
            console.error(`Matrix search error for ${keyword} in ${area}:`, err);
          }
        });

        await Promise.all(batchPromises);
      }
    }

    onProgress?.("অনুসন্ধান সম্পন্ন হয়েছে।");
    return allLeads;
  } catch (error) {
    console.error("Advanced Matrix Search Error:", error);
    onProgress?.("অনুসন্ধানে ত্রুটি হয়েছে।");
    return allLeads;
  }
}
