import { GoogleGenAI, Type } from "@google/genai";
import { Lead, SearchParams } from "../types";

export async function searchGoogleMaps(
  params: SearchParams,
  apiKey: string,
  onBatchUpdate?: (newLeads: Lead[]) => void,
  onProgress?: (message: string) => void
): Promise<Lead[]> {
  const ai = new GoogleGenAI({ apiKey });
  const { query, city, state, country } = params;
  const locationStr = `${city}${state ? `, ${state}` : ""}, ${country}`;

  const allLeads: Lead[] = [];
  const seenNames = new Set<string>();

  try {
    onProgress?.("বিজনেসের ধরন বিশ্লেষণ করছি...");
    // Step 1: Semantic & Bilingual Keyword Expansion
    const keywordResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `For the business type "${query}" in "${country}", list 10 most common alternative categories, synonyms, or related sub-sectors used on Google Maps. 
      If the country is not an English-speaking one, also include terms in the local language (e.g. for Bangladesh, include Bengali terms).
      Format as a simple comma-separated list.`,
    });
    const keywords = [query, ...keywordResponse.text.split(',').map(k => k.trim())].slice(0, 10);

    onProgress?.("শহরের প্রতিটি এলাকা (Neighborhoods) খুঁজে বের করছি...");
    // Step 2: Deep Neighborhood Discovery
    const discoveryResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `List every single major and minor neighborhood, commercial hub, and business district in "${locationStr}". 
      I need an exhaustive list for a deep scan. Include at least 40-50 areas if possible. Format as a comma-separated list.`,
    });
    const discoveredAreas = discoveryResponse.text.split(',').map(a => a.trim()).filter(a => a.length > 0);
    const areasToSearch = [locationStr, ...discoveredAreas].slice(0, 40);

    onProgress?.(`মোট ${areasToSearch.length} টি এলাকায় গভীর অনুসন্ধান শুরু করছি...`);

    // Step 3: Matrix Search (Areas x Keywords)
    for (let i = 0; i < areasToSearch.length; i++) {
      const area = areasToSearch[i];
      onProgress?.(`অনুসন্ধান চলছে: ${area} (${i + 1}/${areasToSearch.length})`);
      
      // We'll prioritize keywords in batches
      for (let j = 0; j < keywords.length; j += 2) {
        const currentKeywords = keywords.slice(j, j + 2);
        
        const batchPromises = currentKeywords.map(async (keyword) => {
          try {
            const searchPrompt = `Find EVERY SINGLE business for "${keyword}" in "${area}, ${country}". 
            You MUST use the Google Maps tool. Be extremely exhaustive. 
            For each business, extract: name, phone, website, rating, and review count.`;

            const response = await ai.models.generateContent({
              model: "gemini-2.0-flash",
              contents: searchPrompt,
              config: { tools: [{ googleMaps: {} } as any] },
            });

            const text = response.text;
            if (!text || text.length < 10) return;
            
            const parseResponse = await ai.models.generateContent({
              model: "gemini-2.0-flash",
              contents: `Extract business info into a JSON array of objects (keys: name, phone, website, rating, reviewCount) from: ${text}. Return ONLY valid JSON.`,
              config: {
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      phone: { type: Type.STRING },
                      website: { type: Type.STRING },
                      rating: { type: Type.NUMBER },
                      reviewCount: { type: Type.NUMBER },
                    },
                    required: ["name"],
                  },
                },
              },
            });

            const leadsData = JSON.parse(parseResponse.text);
            const batchLeads: Lead[] = [];

            const emailPromises = leadsData.map(async (item: any) => {
              const lowerName = item.name.toLowerCase();
              if (!seenNames.has(lowerName)) {
                seenNames.add(lowerName);
                
                const newLead: Lead = {
                  id: `gm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  name: item.name,
                  phone: item.phone || "N/A",
                  website: item.website,
                  location: area,
                  source: "Google Maps",
                  rating: item.rating || 0,
                  reviewCount: item.reviewCount || 0,
                };

                // Background email enrichment
                try {
                  const emailResponse = await ai.models.generateContent({
                    model: "gemini-2.0-flash",
                    contents: `Find official contact email for "${newLead.name}" in "${area}". Website: ${newLead.website || "N/A"}.`,
                    config: { tools: [{ googleSearch: {} } as any] },
                  });
                  const emailMatch = emailResponse.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                  newLead.email = emailMatch ? emailMatch[0] : undefined;
                } catch (e) {}

                batchLeads.push(newLead);
                allLeads.push(newLead);
              }
            });

            await Promise.all(emailPromises);

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

export async function findEmailForLead(lead: Lead, apiKey: string): Promise<string | undefined> {
  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `Find the official contact email for the business "${lead.name}" located in "${lead.location}". Use their website ${lead.website || ""} if provided. Search the web if necessary.`,
      config: {
        tools: [{ googleSearch: {} } as any],
      },
    });

    const emailMatch = response.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return emailMatch ? emailMatch[0] : undefined;
  } catch (error) {
    console.error("Email Search Error:", error);
    return undefined;
  }
}
