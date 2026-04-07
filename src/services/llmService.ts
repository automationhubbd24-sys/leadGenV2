import { APIKeyConfig } from '../types';

let lastUsedIndex: { [provider: string]: number } = {};

export async function callLLM(
  prompt: string,
  configs: APIKeyConfig[],
  systemPrompt: string = "You are a helpful assistant.",
  responseMimeType: string = "text/plain",
  responseSchema?: any,
  onUsageUpdate?: (usage: any) => void
): Promise<string> {
  const activeConfigs = configs.filter(c => c.isActive && c.key);
  if (activeConfigs.length === 0) {
    throw new Error("No active API keys found. Please add and enable them in settings.");
  }

  // Find the next index for the rotation (global or per provider?)
  // Let's do a global rotation among all active keys to balance load
  const providerKey = 'global_rotation';
  if (lastUsedIndex[providerKey] === undefined) lastUsedIndex[providerKey] = -1;
  
  // Try to find a working key, starting from the next one in rotation
  let attempts = 0;
  while (attempts < activeConfigs.length) {
    const currentIndex = (lastUsedIndex[providerKey] + 1) % activeConfigs.length;
    lastUsedIndex[providerKey] = currentIndex;
    const config = activeConfigs[currentIndex];

    try {
      console.log(`Rotating to: ${config.label} (${config.provider})`);
      if (config.provider === 'google' || config.provider === 'custom') {
        return await callGemini(prompt, config, systemPrompt, responseMimeType, responseSchema, onUsageUpdate);
      } else {
        return await callOpenAICompatible(prompt, config, systemPrompt, responseMimeType, responseSchema, onUsageUpdate);
      }
    } catch (err: any) {
      console.error(`Error with provider ${config.provider} (${config.label}):`, err.message);
      attempts++;
      // If we've tried all keys and they failed, we throw the last error
      if (attempts === activeConfigs.length) {
        throw err;
      }
    }
  }

  throw new Error("No working API keys found.");
}

async function callGemini(
  prompt: string,
  config: APIKeyConfig,
  systemPrompt: string,
  responseMimeType: string,
  responseSchema?: any,
  onUsageUpdate?: (usage: any) => void
): Promise<string> {
  const url = config.provider === 'custom' 
    ? `${config.baseUrl}/chat/completions`
    : `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.key}`;
  
  if (config.provider === 'custom') {
    return await callOpenAICompatible(prompt, config, systemPrompt, responseMimeType, responseSchema, onUsageUpdate);
  }

  const body: any = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: responseMimeType,
    }
  };

  if (responseSchema) {
    body.generationConfig.responseSchema = responseSchema;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Gemini API call failed");
  }

  if (data.usageMetadata) {
    onUsageUpdate?.({
      promptTokenCount: data.usageMetadata.promptTokenCount,
      candidatesTokenCount: data.usageMetadata.candidatesTokenCount,
      totalTokenCount: data.usageMetadata.totalTokenCount
    });
  }

  return data.candidates[0].content.parts[0].text;
}

async function callOpenAICompatible(
  prompt: string,
  config: APIKeyConfig,
  systemPrompt: string,
  responseMimeType: string,
  responseSchema?: any,
  onUsageUpdate?: (usage: any) => void
): Promise<string> {
  let baseUrl = config.baseUrl;
  if (!baseUrl) {
    switch (config.provider) {
      case 'groq': baseUrl = 'https://api.groq.com/openai/v1'; break;
      case 'openrouter': baseUrl = 'https://openrouter.ai/api/v1'; break;
      case 'mistral': baseUrl = 'https://api.mistral.ai/v1'; break;
      case 'openai': baseUrl = 'https://api.openai.com/v1'; break;
      case 'custom': baseUrl = 'https://api.salesmanchatbot.online/api/external/v1'; break;
      default: throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  // Remove trailing slash from baseUrl if present
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");

  const body: any = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ],
    response_format: responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
  };

  const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.key}`,
      'HTTP-Referer': 'https://github.com/leadgen-pro', // Optional for OpenRouter
      'X-Title': 'LeadGen Pro' // Optional for OpenRouter
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "LLM API call failed");
  }

  if (data.usage) {
    onUsageUpdate?.({
      promptTokenCount: data.usage.prompt_tokens,
      candidatesTokenCount: data.usage.completion_tokens,
      totalTokenCount: data.usage.total_tokens
    });
  }

  return data.choices[0].message.content;
}
