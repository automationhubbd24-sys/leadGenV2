import axios from "axios";
import { Lead, SearchParams, APIKeyConfig } from "../types";

let yelpRotationIndex = 0;

export async function searchYelp(params: SearchParams, apiConfigs: APIKeyConfig[]): Promise<Lead[]> {
  const { query, city, state, country } = params;
  
  const yelpConfigs = apiConfigs.filter(c => c.label.toLowerCase().includes('yelp') && c.isActive && c.key);
  if (yelpConfigs.length === 0) return [];

  const config = yelpConfigs[yelpRotationIndex % yelpConfigs.length];
  yelpRotationIndex++;

  const locationStr = `${city}${state ? `, ${state}` : ""}, ${country}`;

  try {
    const response = await axios.get("/api/yelp/search", {
      params: {
        term: query,
        location: locationStr,
      },
      headers: {
        'x-yelp-api-key': config.key
      }
    });

    return response.data.businesses.map((b: any) => ({
      id: `yp-${b.id}`,
      name: b.name,
      phone: b.display_phone || b.phone || "N/A",
      location: `${b.location.city}, ${b.location.state || b.location.country}`,
      source: "Yelp",
      website: b.url,
      rating: b.rating,
      reviewCount: b.review_count,
    }));
  } catch (error) {
    console.error("Yelp Search Error:", error);
    return [];
  }
}
