export interface Lead {
  id: string;
  name: string;
  phone: string;
  email?: string;
  location: string;
  source: 'Google Maps' | 'Yelp';
  website?: string;
  rating?: number;
  reviewCount?: number;
}

export interface SearchParams {
  query: string;
  city: string;
  state?: string;
  country: string;
}
