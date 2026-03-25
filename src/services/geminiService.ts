import { GoogleGenAI, Type } from "@google/genai";
import { Lead, SearchParams, APIKeyConfig } from "../types";

let geminiRotationIndex = 0;

function getNextGeminiClient(configs: APIKeyConfig[]) {
  const geminiConfigs = configs.filter(c => c.provider === 'google' && c.isActive && c.key);
  if (geminiConfigs.length === 0) throw new Error("No active Gemini API keys found.");
  
  const config = geminiConfigs[geminiRotationIndex % geminiConfigs.length];
  geminiRotationIndex++;
  console.log(`Rotating Search to Gemini: ${config.label}`);
  return {
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

  try {
    const { ai, model } = getNextGeminiClient(apiConfigs);
    onProgress?.("বিজনেসের ধরন বিশ্লেষণ করছি...");
    // Step 1: Semantic & Bilingual Keyword Expansion
    const keywordResponse = await ai.models.generateContent({
      model: model,
      contents: `For the business type "${query}" in "${country}", list 10 most common alternative categories, synonyms, or related sub-sectors used on Google Maps. 
      If the country is not an English-speaking one, also include terms in the local language (e.g. for Bangladesh, include Bengali terms).
      Format as a simple comma-separated list.`,
    });
    onUsageUpdate?.(keywordResponse.usageMetadata);
    const keywords = [query, ...keywordResponse.text.split(',').map(k => k.trim())].slice(0, 10);

    const { ai: discoveryAi, model: discoveryModel } = getNextGeminiClient(apiConfigs);
    onProgress?.("শহরের প্রতিটি এলাকা (Neighborhoods) খুঁজে বের করছি...");
    // Step 2: Deep Neighborhood Discovery
    const discoveryResponse = await discoveryAi.models.generateContent({
      model: discoveryModel,
      contents: `List every single major and minor neighborhood, commercial hub, and business district in "${locationStr}". 
      I need an exhaustive list for a deep scan. Include at least 40-50 areas if possible. Format as a comma-separated list.`,
    });
    onUsageUpdate?.(discoveryResponse.usageMetadata);
    const discoveredAreas = discoveryResponse.text.split(',').map(a => a.trim()).filter(a => a.length > 0);
    const areasToSearch = [locationStr, ...discoveredAreas].slice(0, 40);

    onProgress?.(`মোট ${areasToSearch.length} টি এলাকায় গভীর অনুসন্ধান শুরু করছি...`);

    // Step 3: Matrix Search (Areas x Keywords)
    const activeConfigs = apiConfigs.filter(c => c.provider === 'google' && c.isActive && c.key);
    const concurrency = Math.max(2, activeConfigs.length);

    for (let i = 0; i < areasToSearch.length; i++) {
      const area = areasToSearch[i];
      onProgress?.(`অনুসন্ধান চলছে: ${area} (${i + 1}/${areasToSearch.length})`);
      
      // We'll prioritize keywords in batches
      for (let j = 0; j < keywords.length; j += concurrency) {
        const currentKeywords = keywords.slice(j, j + concurrency);
        
        const batchPromises = currentKeywords.map(async (keyword) => {
          try {
            const searchAi = getNextGeminiClient(apiConfigs);
            const searchPrompt = `Find EVERY SINGLE business for "${keyword}" in "${area}, ${country}". 
            You MUST use the Google Maps tool. Be extremely exhaustive. 
            For each business, extract: name, phone, website, rating, and review count.
            CRITICAL: Also find the official contact email for each business. Use the website or your internal knowledge to provide the most accurate email.`;

            const response = await searchAi.ai.models.generateContent({
              model: searchAi.model,
              contents: searchPrompt,
              config: { tools: [{ googleMaps: {} } as any] },
            });
            onUsageUpdate?.(response.usageMetadata);

            const text = response.text;
            if (!text || text.length < 10) return;
            
            const parseAi = getNextGeminiClient(apiConfigs);
            const parseResponse = await parseAi.ai.models.generateContent({
              model: parseAi.model,
              contents: `Extract business info into a JSON array of objects (keys: name, phone, email, website, rating, reviewCount) from: ${text}. Return ONLY valid JSON. If email is not found, use null.`,
              config: {
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      phone: { type: Type.STRING },
                      email: { type: Type.STRING, nullable: true },
                      website: { type: Type.STRING },
                      rating: { type: Type.NUMBER },
                      reviewCount: { type: Type.NUMBER },
                    },
                    required: ["name"],
                  },
                },
              },
            });
            onUsageUpdate?.(parseResponse.usageMetadata);

            const leadsData = JSON.parse(parseResponse.text);
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
