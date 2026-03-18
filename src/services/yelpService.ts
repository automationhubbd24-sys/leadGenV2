import axios from "axios";
import { Lead, SearchParams } from "../types";

export async function searchYelp(params: SearchParams, apiKey: string): Promise<Lead[]> {
  const { query, city, state, country } = params;
  
  // Yelp is primarily for USA, but supports some other countries.
  // We'll construct the location string.
  const locationStr = `${city}${state ? `, ${state}` : ""}, ${country}`;

  try {
    const response = await axios.get("/api/yelp/search", {
      params: {
        term: query,
        location: locationStr,
      },
      headers: {
        'x-yelp-api-key': apiKey
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
