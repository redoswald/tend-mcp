/**
 * Metro area normalization — maps common city/area aliases to canonical metro area names.
 */

const METRO_ALIASES: Record<string, string> = {
  "dc": "Washington, DC", "d.c.": "Washington, DC", "washington dc": "Washington, DC",
  "washington, dc": "Washington, DC", "washington d.c.": "Washington, DC",
  "washington, d.c.": "Washington, DC", "dmv": "Washington, DC",
  "arlington": "Washington, DC", "bethesda": "Washington, DC",
  "silver spring": "Washington, DC", "alexandria": "Washington, DC",
  "nyc": "New York, NY", "new york": "New York, NY", "new york city": "New York, NY",
  "new york, ny": "New York, NY", "manhattan": "New York, NY",
  "brooklyn": "New York, NY", "queens": "New York, NY", "bronx": "New York, NY",
  "staten island": "New York, NY", "jersey city": "New York, NY",
  "sf": "San Francisco, CA", "san francisco": "San Francisco, CA",
  "san francisco, ca": "San Francisco, CA", "bay area": "San Francisco, CA",
  "oakland": "San Francisco, CA", "berkeley": "San Francisco, CA",
  "san jose": "San Francisco, CA", "palo alto": "San Francisco, CA",
  "la": "Los Angeles, CA", "los angeles": "Los Angeles, CA",
  "los angeles, ca": "Los Angeles, CA", "santa monica": "Los Angeles, CA",
  "pasadena": "Los Angeles, CA", "burbank": "Los Angeles, CA",
  "chi": "Chicago, IL", "chicago": "Chicago, IL", "chicago, il": "Chicago, IL",
  "boston": "Boston, MA", "boston, ma": "Boston, MA", "cambridge": "Boston, MA",
  "somerville": "Boston, MA",
  "seattle": "Seattle, WA", "seattle, wa": "Seattle, WA", "bellevue": "Seattle, WA",
  "miami": "Miami, FL", "miami, fl": "Miami, FL",
  "ft lauderdale": "Miami, FL", "fort lauderdale": "Miami, FL",
  "atl": "Atlanta, GA", "atlanta": "Atlanta, GA", "atlanta, ga": "Atlanta, GA",
  "dallas": "Dallas, TX", "dallas, tx": "Dallas, TX", "dfw": "Dallas, TX",
  "fort worth": "Dallas, TX",
  "houston": "Houston, TX", "houston, tx": "Houston, TX",
  "austin": "Austin, TX", "austin, tx": "Austin, TX",
  "denver": "Denver, CO", "denver, co": "Denver, CO",
  "philly": "Philadelphia, PA", "philadelphia": "Philadelphia, PA",
  "philadelphia, pa": "Philadelphia, PA",
  "phoenix": "Phoenix, AZ", "phoenix, az": "Phoenix, AZ", "scottsdale": "Phoenix, AZ",
  "minneapolis": "Minneapolis, MN", "minneapolis, mn": "Minneapolis, MN",
  "twin cities": "Minneapolis, MN", "st paul": "Minneapolis, MN",
  "portland": "Portland, OR", "portland, or": "Portland, OR",
  "detroit": "Detroit, MI", "detroit, mi": "Detroit, MI",
  "san diego": "San Diego, CA", "san diego, ca": "San Diego, CA",
  "nashville": "Nashville, TN", "nashville, tn": "Nashville, TN",
  "london": "London, UK", "paris": "Paris, France", "tokyo": "Tokyo, Japan",
  "toronto": "Toronto, Canada", "vancouver": "Vancouver, Canada",
  "berlin": "Berlin, Germany", "sydney": "Sydney, Australia",
  "melbourne": "Melbourne, Australia",
};

function titleCase(str: string): string {
  return str
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function normalizeMetroArea(input: string | null | undefined): string | null {
  if (!input || !input.trim()) return null;
  const normalized = input.trim().toLowerCase();
  return METRO_ALIASES[normalized] || titleCase(normalized);
}
