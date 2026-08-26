import {
  jwtVerify,
  createRemoteJWKSet
} from "jose";

const MODEL =
  "@cf/meta/llama-3.1-8b-instruct-fast";

const MAX_CONTEXT_MESSAGES = 24;

// The single built-in voice used by Tom's AI.
const VOICE_MODEL = "@cf/deepgram/aura-1";
const VOICE_SPEAKER = "luna";
const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
const FALLBACK_TRANSCRIPTION_MODEL = "@cf/openai/whisper";
const MAX_TRANSCRIPTION_AUDIO_BYTES = 5 * 1024 * 1024;

const DEFAULT_HOME_LOCATION = "Eston, England";
const ENGLAND_TIME_ZONE = "Europe/London";
const MET_OFFICE_WEATHER_URL =
  "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly";
const OPEN_METEO_GEOCODING_URL =
  "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL =
  "https://api.open-meteo.com/v1/forecast";
const POSTCODES_IO_URL =
  "https://api.postcodes.io/postcodes";

const ESTON_LOCATION = Object.freeze({
  name: "Eston",
  displayName: "Eston, Redcar and Cleveland, England",
  latitude: 54.55932,
  longitude: -1.1434,
  timezone: ENGLAND_TIME_ZONE,
  country: "United Kingdom",
  countryCode: "GB",
  admin1: "England",
  admin2: "Redcar and Cleveland"
});

// Cloudflare Access configuration for your Tom's AI application.
const TEAM_DOMAIN =
  "https://shrill-snowflake-7123.cloudflareaccess.com";

const POLICY_AUD =
  "904c21185d6c40c0f1fa1e0aaeaae2da5fe9818afa54b1507e3bf647a257d11f";

const JWKS =
  createRemoteJWKSet(
    new URL(
      `${TEAM_DOMAIN}/cdn-cgi/access/certs`
    )
  );


function json(
  data,
  status = 200,
  extraHeaders = {}
) {
  return Response.json(
    data,
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...extraHeaders
      }
    }
  );
}


/* ==================================================
   CLOUDFLARE ACCESS AUTHENTICATION
   ================================================== */

async function getAuthenticatedUser(request) {

  const token =
    request.headers.get(
      "cf-access-jwt-assertion"
    );

  if (!token) {
    throw new Error(
      "Missing Cloudflare Access authentication."
    );
  }

  const { payload } =
    await jwtVerify(
      token,
      JWKS,
      {
        issuer: TEAM_DOMAIN,
        audience: POLICY_AUD
      }
    );

  const subject =
    typeof payload.sub === "string"
      ? payload.sub.trim()
      : "";

  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : "";

  if (!subject && !email) {
    throw new Error(
      "Authenticated user identity was not provided."
    );
  }

  /*
    Use the stable Access subject where available.
    Email is only a fallback.
  */
  const identity =
    subject || email;

  return {
    userId: `cf:${identity}`,
    email
  };
}


/* ==================================================
   LEGACY DATA MIGRATION
   ==================================================

   Your existing data was stored under:

   default-user

   When your account signs in for the first time, move that
   existing data to the authenticated account.

   This does NOT delete messages. Messages belong to
   conversations, so changing the conversation owner is enough.
   ================================================== */

async function migrateLegacyUser(
  db,
  userId
) {

  if (userId === "cf:default-user") {
    return;
  }

  const currentUser =
    await db
      .prepare(`
        SELECT
          (
            SELECT COUNT(*)
            FROM conversations
            WHERE user_id = ?
          )
          +
          (
            SELECT COUNT(*)
            FROM memories
            WHERE user_id = ?
          )
          AS total
      `)
      .bind(
        userId,
        userId
      )
      .first();

  const legacyUser =
    await db
      .prepare(`
        SELECT
          (
            SELECT COUNT(*)
            FROM conversations
            WHERE user_id = 'default-user'
          )
          +
          (
            SELECT COUNT(*)
            FROM memories
            WHERE user_id = 'default-user'
          )
          AS total
      `)
      .first();

  const currentCount =
    Number(
      currentUser?.total || 0
    );

  const legacyCount =
    Number(
      legacyUser?.total || 0
    );

  /*
    Only migrate legacy data when the authenticated user
    has no existing data yet.

    This means your current data gets attached to your
    first authenticated account, while later users start
    with completely separate data.
  */

  if (
    currentCount === 0 &&
    legacyCount > 0
  ) {

    await db.batch([
      db
        .prepare(`
          UPDATE conversations
          SET user_id = ?
          WHERE user_id = 'default-user'
        `)
        .bind(userId),

      db
        .prepare(`
          UPDATE memories
          SET user_id = ?
          WHERE user_id = 'default-user'
        `)
        .bind(userId)
    ]);
  }
}


/* ==================================================
   TEXT HELPERS
   ================================================== */

function cleanText(
  value,
  maxLength = 10000
) {

  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .trim()
    .slice(0, maxLength);
}


function cleanHistory(history) {

  if (
    !Array.isArray(history)
  ) {
    return [];
  }

  return history
    .filter(
      item =>
        item &&
        (
          item.role === "user" ||
          item.role === "assistant"
        ) &&
        typeof item.content === "string"
    )
    .slice(-20)
    .map(
      item => ({
        role: item.role,
        content:
          item.content.slice(
            0,
            10000
          )
      })
    );
}


function extractAIResponse(result) {

  if (!result) {
    return "";
  }

  if (
    typeof result.response === "string"
  ) {
    return result.response.trim();
  }

  return "";
}


function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (
    let offset = 0;
    offset < bytes.length;
    offset += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(
        offset,
        Math.min(offset + chunkSize, bytes.length)
      )
    );
  }

  return btoa(binary);
}


function asksForCurrentDateOrTime(message) {

  if (typeof message !== "string") {
    return false;
  }

  const mentionsDateOrTime =
    /\b(?:date|day|time)\b/i.test(message);

  const asksForNow =
    /\b(?:now|right\s+now|current|currently|today)\b/i.test(message) ||
    /\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:date|day|time)\b/i.test(message) ||
    /\bwhat\s+(?:date|day|time)\s+is\s+it\b/i.test(message);

  return mentionsDateOrTime && asksForNow;
}


function asksForCurrentTime(message) {
  return asksForCurrentDateOrTime(message) &&
    /\btime\b/i.test(message);
}


function getCurrentDateTimeContext(
  body,
  preferredTimeZone = ""
) {

  const now = new Date();
  const requestedTimeZone =
    cleanText(
      preferredTimeZone ||
        body?.clientTimeZone,
      80
    );

  let timeZone = "UTC";
  let timeZoneLabel = "UTC";
  let displayDate = now;

  if (requestedTimeZone) {

    try {

      new Intl.DateTimeFormat(
        "en-GB",
        { timeZone: requestedTimeZone }
      ).format(now);

      timeZone = requestedTimeZone;
      timeZoneLabel = requestedTimeZone;

    } catch (error) {

      console.warn(
        "Invalid client time zone; using UTC offset fallback.",
        requestedTimeZone
      );
    }
  }

  if (
    timeZone === "UTC" &&
    requestedTimeZone !== "UTC"
  ) {

    const requestedOffset =
      Number(
        body?.clientUtcOffsetMinutes
      );

    if (
      Number.isFinite(requestedOffset) &&
      requestedOffset >= -840 &&
      requestedOffset <= 840
    ) {

      displayDate =
        new Date(
          now.getTime() +
          requestedOffset * 60 * 1000
        );

      const sign =
        requestedOffset >= 0
          ? "+"
          : "-";

      const absoluteOffset =
        Math.abs(requestedOffset);

      const offsetHours =
        String(
          Math.floor(
            absoluteOffset / 60
          )
        ).padStart(2, "0");

      const offsetMinutes =
        String(
          absoluteOffset % 60
        ).padStart(2, "0");

      timeZoneLabel =
        `UTC${sign}${offsetHours}:${offsetMinutes}`;
    }
  }

  const date =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }
    ).format(displayDate);

  const time =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }
    ).format(displayDate);

  return {
    date,
    time,
    timeZone: timeZoneLabel,
    utc: now.toISOString()
  };
}


function asksForWeather(message) {
  return typeof message === "string" &&
    /\b(?:weather|forecast|temperature|degrees|rain|raining|snow|snowing|wind|windy|sunny|cloudy|hot|cold|warm|chilly|umbrella)\b/i.test(message);
}


function asksForLocationDateOrTime(message) {
  return typeof message === "string" &&
    /\b(?:date|day|time)\b/i.test(message) &&
    /\b(?:in\s+[a-z]|near\s+[a-z]|around\s+[a-z]|at\s+home|here|my\s+(?:location|area))\b/i.test(message);
}


function hasNonCurrentWeatherTime(message) {
  return /\b(?:tomorrow|tonight|later|yesterday|next|last|weekend|morning|afternoon|evening|overnight|forecast|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(message);
}


function asksForSimpleCurrentWeather(message) {
  if (!asksForWeather(message) || hasNonCurrentWeatherTime(message)) {
    return false;
  }

  return true;
}


function normalizePlaceText(value) {
  return cleanText(value, 120)
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


function cleanHomeLocation(value) {
  return normalizePlaceText(value)
    .replace(/[^a-z0-9 .,'’()\-]/gi, "")
    .slice(0, 120)
    .trim();
}


function trimPlaceCandidate(value) {
  return normalizePlaceText(value)
    .replace(
      /\s+\b(?:right\s+now|now|today|tomorrow|tonight|yesterday|this\s+(?:morning|afternoon|evening|week|weekend)|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last\s+(?:night|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b.*$/i,
      ""
    )
    .replace(
      /\s+\b(?:this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|the\s+\d{1,2}(?:st|nd|rd|th)?)|in\s+\d+\s+(?:hours?|days?|weeks?)|for\s+(?:today|tomorrow|tonight|this\s+\w+|next\s+\w+))\b.*$/i,
      ""
    )
    .replace(
      /\s+\b(?:and\s+(?:tell|show|give|the|what)|then\s+(?:tell|show|give)|please|thanks)\b.*$/i,
      ""
    )
    .replace(/\s+\b(?:for|on|at|in)\s*$/i, "")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}


function isTemporalPlaceCandidate(value) {
  return /^(?:today|tomorrow|tonight|yesterday|now|right\s+now|this\s+(?:morning|afternoon|evening|week|weekend)|next\s+\w+|last\s+\w+|\d+\s+(?:minutes?|hours?|days?|weeks?))\b/i.test(
    value
  );
}


function extractRequestedPlace(
  message,
  homeLocation
) {
  const text = normalizePlaceText(message);
  const home = normalizePlaceText(homeLocation) || DEFAULT_HOME_LOCATION;

  if (
    /\b(?:here|at\s+home|near\s+me|my\s+(?:location|area)|where\s+i\s+(?:am|live))\b/i.test(text)
  ) {
    return {
      query: home,
      usedHomeLocation: true
    };
  }

  const candidates = [];
  const prepositionPattern =
    /\b(?:in|for|near|around)\s+([^?\n]+)/gi;

  for (const match of text.matchAll(prepositionPattern)) {
    const candidate = trimPlaceCandidate(match[1]);
    if (
      candidate &&
      !isTemporalPlaceCandidate(candidate)
    ) {
      candidates.push(candidate);
    }
  }

  for (const match of text.matchAll(/\bin\s+([^?\n]+)/gi)) {
    const candidate = trimPlaceCandidate(match[1]);
    if (
      candidate &&
      !isTemporalPlaceCandidate(candidate)
    ) {
      candidates.push(candidate);
    }
  }

  const atPattern = /\bat\s+([^?\n]+)/gi;
  for (const match of text.matchAll(atPattern)) {
    const candidate = trimPlaceCandidate(match[1]);
    if (
      candidate &&
      !isTemporalPlaceCandidate(candidate) &&
      !/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(candidate)
    ) {
      candidates.push(candidate);
    }
  }

  const placeFirst = text.match(
    /^([a-z][a-z .,'’-]{1,100}?)\s+(?:weather|forecast|temperature|time|date)\b/i
  );

  if (
    placeFirst?.[1] &&
    !/^(?:what|what's|whats|how|is|are|will|would|can|could|tell|show|give)\b/i.test(
      placeFirst[1].trim()
    )
  ) {
    const candidate = trimPlaceCandidate(placeFirst[1]);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  if (candidates.length > 0) {
    return {
      query: candidates[candidates.length - 1],
      usedHomeLocation: false
    };
  }

  return {
    query: home,
    usedHomeLocation: true
  };
}


function placeKey(value) {
  return normalizePlaceText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


function isEstonHomeQuery(value) {
  const key = placeKey(value);
  return key === "eston" ||
    key === "eston england" ||
    key === "eston uk" ||
    key === "eston redcar and cleveland england";
}


function extractUkPostcode(value) {
  const compact = normalizePlaceText(value)
    .toUpperCase()
    .replace(/\s+/g, "");
  const match = compact.match(
    /\b(?:GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})\b/
  );
  return match?.[0] || "";
}


async function geocodeUkPostcode(postcode) {
  const endpoint =
    `${POSTCODES_IO_URL}/${encodeURIComponent(postcode)}`;
  const response = await fetch(
    endpoint,
    {
      headers: {
        Accept: "application/json"
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 604800
      }
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Postcode service returned ${response.status}.`
    );
  }

  const data = await response.json();
  const result = data?.result;

  if (
    !result ||
    !Number.isFinite(Number(result.latitude)) ||
    !Number.isFinite(Number(result.longitude))
  ) {
    return null;
  }

  const placeName = cleanText(
    result.bua ||
      result.parish ||
      result.admin_ward ||
      result.postcode,
    120
  );
  const district = cleanText(
    result.admin_district,
    120
  );
  const country = cleanText(
    result.country,
    80
  );
  const displayParts = [
    placeName,
    district,
    country,
    cleanText(result.postcode, 16)
  ].filter(Boolean);

  return {
    name: placeName,
    displayName:
      [...new Set(displayParts)].join(", "),
    latitude: Number(result.latitude),
    longitude: Number(result.longitude),
    timezone: ENGLAND_TIME_ZONE,
    country: "United Kingdom",
    countryCode: "GB",
    admin1: country,
    admin2: district
  };
}


function formatGeocodedPlace(result) {
  const parts = [result.name];

  if (result.admin2 && result.admin2 !== result.name) {
    parts.push(result.admin2);
  } else if (result.admin1 && result.admin1 !== result.name) {
    parts.push(result.admin1);
  }

  if (result.admin1 === "England") {
    if (!parts.includes("England")) {
      parts.push("England");
    }
  } else if (result.country && !parts.includes(result.country)) {
    parts.push(result.country);
  }

  return [...new Set(parts.filter(Boolean))].join(", ");
}


async function fetchGeocodingResults(
  query,
  englandOnly
) {
  const endpoint = new URL(
    OPEN_METEO_GEOCODING_URL
  );

  endpoint.searchParams.set(
    "name",
    englandOnly && !/\b(?:england|united\s+kingdom|uk|gb)\b/i.test(query)
      ? `${query}, England`
      : query
  );
  endpoint.searchParams.set("count", "10");
  endpoint.searchParams.set("language", "en");
  endpoint.searchParams.set("format", "json");

  if (englandOnly) {
    endpoint.searchParams.set("countryCode", "GB");
  }

  const response = await fetch(
    endpoint,
    {
      headers: {
        Accept: "application/json"
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 86400
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Location service returned ${response.status}.`
    );
  }

  const data = await response.json();
  return Array.isArray(data?.results)
    ? data.results
    : [];
}


function scoreLocationResult(
  result,
  query
) {
  const requested = placeKey(query)
    .replace(/\b(?:england|united kingdom|uk|gb)\b/g, "")
    .trim();
  const name = placeKey(result?.name);
  let score = 0;

  if (name === requested) {
    score += 100;
  } else if (
    name &&
    requested &&
    (name.includes(requested) || requested.includes(name))
  ) {
    score += 40;
  }

  if (result?.admin1 === "England") {
    score += 30;
  }

  score += Math.min(
    20,
    Math.log10(
      Math.max(1, Number(result?.population) || 1)
    ) * 3
  );

  return score;
}


async function geocodePlace(query) {
  const cleanedQuery = normalizePlaceText(query);

  if (!cleanedQuery) {
    return null;
  }

  const postcode = extractUkPostcode(
    cleanedQuery
  );

  if (postcode) {
    return geocodeUkPostcode(postcode);
  }

  if (isEstonHomeQuery(cleanedQuery)) {
    return { ...ESTON_LOCATION };
  }

  let results = await fetchGeocodingResults(
    cleanedQuery,
    true
  );

  let candidates = results.filter(
    result =>
      result?.country_code === "GB" &&
      result?.admin1 === "England"
  );

  if (candidates.length === 0) {
    results = await fetchGeocodingResults(
      cleanedQuery,
      false
    );
    candidates = results;
  }

  const best = candidates
    .filter(
      result =>
        Number.isFinite(Number(result?.latitude)) &&
        Number.isFinite(Number(result?.longitude)) &&
        typeof result?.timezone === "string"
    )
    .sort(
      (left, right) =>
        scoreLocationResult(right, cleanedQuery) -
        scoreLocationResult(left, cleanedQuery)
    )[0];

  if (!best) {
    return null;
  }

  return {
    name: cleanText(best.name, 120),
    displayName: formatGeocodedPlace(best),
    latitude: Number(best.latitude),
    longitude: Number(best.longitude),
    timezone: cleanText(best.timezone, 80),
    country: cleanText(best.country, 80),
    countryCode: cleanText(best.country_code, 8),
    admin1: cleanText(best.admin1, 80),
    admin2: cleanText(best.admin2, 80)
  };
}


function describeWmoWeather(code) {
  const value = Number(code);

  if (value === 0) return "clear";
  if (value === 1) return "mainly clear";
  if (value === 2) return "partly cloudy";
  if (value === 3) return "overcast";
  if ([45, 48].includes(value)) return "foggy";
  if ([51, 53, 55].includes(value)) return "drizzly";
  if ([56, 57].includes(value)) return "freezing drizzle";
  if ([61, 63, 65].includes(value)) return "rainy";
  if ([66, 67].includes(value)) return "freezing rain";
  if ([71, 73, 75, 77].includes(value)) return "snowy";
  if ([80, 81, 82].includes(value)) return "rain showers";
  if ([85, 86].includes(value)) return "snow showers";
  if ([95, 96, 99].includes(value)) return "thunderstorms";
  return "mixed conditions";
}


function describeMetOfficeWeather(code) {
  const descriptions = {
    0: "clear night",
    1: "sunny",
    2: "partly cloudy",
    3: "partly cloudy",
    5: "misty",
    6: "foggy",
    7: "cloudy",
    8: "overcast",
    9: "light rain showers",
    10: "light rain showers",
    11: "drizzly",
    12: "light rain",
    13: "heavy rain showers",
    14: "heavy rain showers",
    15: "heavy rain",
    16: "sleet showers",
    17: "sleet showers",
    18: "sleet",
    19: "hail showers",
    20: "hail showers",
    21: "hail",
    22: "light snow showers",
    23: "light snow showers",
    24: "light snow",
    25: "heavy snow showers",
    26: "heavy snow showers",
    27: "heavy snow",
    28: "thunder showers",
    29: "thunder showers",
    30: "thunderstorms"
  };

  return descriptions[Number(code)] ||
    "mixed conditions";
}


function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number
    : null;
}


function pickNearestWeatherPeriod(periods) {
  const now = Date.now();
  let nearest = null;
  let nearestDistance = Infinity;

  for (const period of periods) {
    const timestamp = Date.parse(period?.time);
    if (!Number.isFinite(timestamp)) continue;
    const distance = Math.abs(timestamp - now);
    if (distance < nearestDistance) {
      nearest = period;
      nearestDistance = distance;
    }
  }

  return nearest || periods[0] || null;
}


async function fetchMetOfficeWeather(
  env,
  location
) {
  if (!env.MET_OFFICE_API_KEY) {
    return null;
  }

  const endpoint = new URL(
    MET_OFFICE_WEATHER_URL
  );
  endpoint.searchParams.set(
    "excludeParameterMetadata",
    "true"
  );
  endpoint.searchParams.set(
    "includeLocationName",
    "true"
  );
  endpoint.searchParams.set(
    "latitude",
    String(location.latitude)
  );
  endpoint.searchParams.set(
    "longitude",
    String(location.longitude)
  );
  endpoint.searchParams.set(
    "datasource",
    "BD1"
  );

  const response = await fetch(
    endpoint,
    {
      headers: {
        Accept: "application/json",
        apikey: env.MET_OFFICE_API_KEY
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 900
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Met Office Weather DataHub returned ${response.status}.`
    );
  }

  const data = await response.json();
  const feature = Array.isArray(data?.features)
    ? data.features[0]
    : null;
  const properties = feature?.properties || {};
  const rawPeriods = Array.isArray(properties.timeSeries)
    ? properties.timeSeries
    : [];

  const periods = rawPeriods
    .map(period => ({
      time: cleanText(period?.time, 60),
      temperature: numberOrNull(period?.screenTemperature),
      feelsLike: numberOrNull(period?.feelsLikeTemperature),
      condition: describeMetOfficeWeather(period?.significantWeatherCode),
      precipitationProbability: numberOrNull(
        period?.probOfPrecipitation ??
        period?.probabilityOfPrecipitation
      ),
      precipitation: numberOrNull(
        period?.totalPrecipAmount ??
        period?.precipitationRate
      ),
      windSpeed: numberOrNull(period?.windSpeed10m),
      windGust: numberOrNull(period?.windGustSpeed10m)
    }))
    .filter(period => period.time)
    .slice(0, 192);

  if (periods.length === 0) {
    throw new Error(
      "Met Office returned no hourly forecast periods."
    );
  }

  return {
    provider: "Met Office Weather DataHub",
    model: "Met Office Global Spot site-specific forecast",
    location,
    updatedAt: cleanText(
      properties.modelRunDate,
      60
    ) || periods[0].time,
    current: pickNearestWeatherPeriod(periods),
    hourly: periods,
    daily: [],
    source: {
      title: "Met Office Weather DataHub",
      url: "https://www.metoffice.gov.uk/services/data/met-office-weather-datahub",
      snippet: "Official Met Office site-specific forecast data, updated hourly."
    }
  };
}


async function fetchOpenMeteoWeather(location) {
  const endpoint = new URL(
    OPEN_METEO_FORECAST_URL
  );
  endpoint.searchParams.set(
    "latitude",
    String(location.latitude)
  );
  endpoint.searchParams.set(
    "longitude",
    String(location.longitude)
  );
  endpoint.searchParams.set(
    "current",
    [
      "temperature_2m",
      "apparent_temperature",
      "weather_code",
      "precipitation",
      "rain",
      "wind_speed_10m",
      "wind_gusts_10m"
    ].join(",")
  );
  endpoint.searchParams.set(
    "hourly",
    [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "rain",
      "showers",
      "snowfall",
      "weather_code",
      "wind_speed_10m",
      "wind_gusts_10m"
    ].join(",")
  );
  endpoint.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "rain_sum",
      "snowfall_sum",
      "wind_speed_10m_max",
      "wind_gusts_10m_max"
    ].join(",")
  );
  endpoint.searchParams.set(
    "forecast_days",
    "7"
  );
  endpoint.searchParams.set(
    "timezone",
    location.timezone || "auto"
  );

  const usesUkMetOfficeModel =
    location.admin1 === "England" ||
    location.countryCode === "GB";

  endpoint.searchParams.set(
    "models",
    usesUkMetOfficeModel
      ? "ukmo_seamless"
      : "best_match"
  );

  const response = await fetch(
    endpoint,
    {
      headers: {
        Accept: "application/json"
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 900
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Weather service returned ${response.status}.`
    );
  }

  const data = await response.json();
  const hourlyTimes = Array.isArray(data?.hourly?.time)
    ? data.hourly.time
    : [];
  const dailyTimes = Array.isArray(data?.daily?.time)
    ? data.daily.time
    : [];

  const hourly = hourlyTimes
    .map((time, index) => ({
      time: cleanText(time, 60),
      temperature: numberOrNull(data.hourly?.temperature_2m?.[index]),
      feelsLike: numberOrNull(data.hourly?.apparent_temperature?.[index]),
      condition: describeWmoWeather(data.hourly?.weather_code?.[index]),
      precipitation: numberOrNull(data.hourly?.precipitation?.[index]),
      rain: numberOrNull(data.hourly?.rain?.[index]),
      showers: numberOrNull(data.hourly?.showers?.[index]),
      snowfall: numberOrNull(data.hourly?.snowfall?.[index]),
      windSpeed: numberOrNull(data.hourly?.wind_speed_10m?.[index]),
      windGust: numberOrNull(data.hourly?.wind_gusts_10m?.[index])
    }))
    .slice(0, 192);

  const daily = dailyTimes
    .map((time, index) => ({
      date: cleanText(time, 30),
      condition: describeWmoWeather(data.daily?.weather_code?.[index]),
      temperatureMax: numberOrNull(data.daily?.temperature_2m_max?.[index]),
      temperatureMin: numberOrNull(data.daily?.temperature_2m_min?.[index]),
      precipitation: numberOrNull(data.daily?.precipitation_sum?.[index]),
      rain: numberOrNull(data.daily?.rain_sum?.[index]),
      snowfall: numberOrNull(data.daily?.snowfall_sum?.[index]),
      windSpeedMax: numberOrNull(data.daily?.wind_speed_10m_max?.[index]),
      windGustMax: numberOrNull(data.daily?.wind_gusts_10m_max?.[index])
    }))
    .slice(0, 7);

  const current = data?.current
    ? {
        time: cleanText(data.current.time, 60),
        temperature: numberOrNull(data.current.temperature_2m),
        feelsLike: numberOrNull(data.current.apparent_temperature),
        condition: describeWmoWeather(data.current.weather_code),
        precipitation: numberOrNull(data.current.precipitation),
        rain: numberOrNull(data.current.rain),
        windSpeed: numberOrNull(data.current.wind_speed_10m),
        windGust: numberOrNull(data.current.wind_gusts_10m)
      }
    : pickNearestWeatherPeriod(hourly);

  if (!current) {
    throw new Error(
      "Weather service returned no forecast periods."
    );
  }

  return {
    provider: usesUkMetOfficeModel
      ? "UK Met Office model via Open-Meteo"
      : "Open-Meteo best-match forecast",
    model: usesUkMetOfficeModel
      ? "UKMO seamless"
      : "Best match for this location",
    location,
    updatedAt: current.time,
    current,
    hourly,
    daily,
    source: {
      title: usesUkMetOfficeModel
        ? "UK Met Office forecast model via Open-Meteo"
        : "Open-Meteo forecast",
      url: "https://open-meteo.com/en/docs",
      snippet: usesUkMetOfficeModel
        ? "Open-Meteo delivery of the UK Met Office seamless forecast model."
        : "Location-specific forecast data supplied by Open-Meteo."
    }
  };
}


async function getWeatherForLocation(
  env,
  location
) {
  try {
    const metOfficeWeather =
      await fetchMetOfficeWeather(
        env,
        location
      );

    if (metOfficeWeather) {
      return metOfficeWeather;
    }
  } catch (error) {
    console.error(
      "Met Office Weather DataHub error:",
      error
    );
  }

  return fetchOpenMeteoWeather(location);
}


function formatWeatherValue(value, suffix = "") {
  return value === null || value === undefined
    ? "not supplied"
    : `${value}${suffix}`;
}


function createWeatherContextText(weather) {
  if (!weather) {
    return "No verified weather data is available.";
  }

  const current = weather.current || {};
  const hourly = (weather.hourly || [])
    .map(period =>
      `${period.time}: ${formatWeatherValue(period.temperature, "°C")}, feels ${formatWeatherValue(period.feelsLike, "°C")}, ${period.condition}, precipitation ${formatWeatherValue(period.precipitation, " mm")}, wind ${formatWeatherValue(period.windSpeed, " km/h")}`
    )
    .join("\n");
  const daily = (weather.daily || [])
    .map(period =>
      `${period.date}: ${period.condition}, low ${formatWeatherValue(period.temperatureMin, "°C")}, high ${formatWeatherValue(period.temperatureMax, "°C")}, precipitation ${formatWeatherValue(period.precipitation, " mm")}`
    )
    .join("\n");

  return `
Verified place: ${weather.location.displayName}
Coordinates used: ${weather.location.latitude}, ${weather.location.longitude}
Time zone: ${weather.location.timezone}

CURRENT CONDITIONS:
Time: ${current.time}
Temperature: ${formatWeatherValue(current.temperature, "°C")}
Feels like: ${formatWeatherValue(current.feelsLike, "°C")}
Conditions: ${current.condition || "not supplied"}
Precipitation: ${formatWeatherValue(current.precipitation, " mm")}
Wind: ${formatWeatherValue(current.windSpeed, " km/h")}
Wind gusts: ${formatWeatherValue(current.windGust, " km/h")}

HOURLY DATA:
${hourly || "No hourly data supplied."}

DAILY SUMMARY:
${daily || "No daily summary supplied by this provider."}
`.trim();
}


function createCurrentWeatherAnswer(
  weather
) {
  const current = weather.current;
  const temperature = formatWeatherValue(
    current.temperature,
    "°C"
  );
  const wind = formatWeatherValue(
    current.windSpeed,
    " km/h"
  );

  return `In ${weather.location.displayName}, the temperature is ${temperature}. Wind is ${wind}.`;
}

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

async function createEmbedding(env, text) {
  const result = await env.AI.run(EMBEDDING_MODEL, {
    text: text.slice(0, 3000),
    pooling: "cls"
  });
  const vector = Array.isArray(result?.data) ? result.data[0] : null;
  return Array.isArray(vector) ? vector : null;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude) || 1);
}

function lexicalSimilarity(query, value) {
  const terms = new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) || []));
  if (!terms.size) return 0;
  const text = new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) || []));
  let matches = 0;
  for (const term of terms) if (text.has(term)) matches += 1;
  return matches / terms.size;
}

async function getRelevantMemories(db, env, userId, query) {
  const result = await db.prepare(`
    SELECT id, memory, embedding_json FROM memories
    WHERE user_id = ? ORDER BY updated_at DESC LIMIT 80
  `).bind(userId).all();
  const memories = result.results || [];

  const lexicalMatches = memories
    .map(memory => ({
      ...memory,
      score: lexicalSimilarity(query, memory.memory)
    }))
    .filter(memory => memory.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (lexicalMatches.length > 0) {
    return lexicalMatches;
  }

  const explicitlyAsksForMemory =
    /\b(?:remember|memory|memories|what\s+do\s+you\s+know\s+about\s+me|what\s+do\s+i\s+like|my\s+favou?rite)\b/i.test(
      query
    );

  if (!explicitlyAsksForMemory) {
    return [];
  }

  try {
    const queryEmbedding = await createEmbedding(env, query);
    if (queryEmbedding) {
      return memories
        .map(memory => ({
          ...memory,
          score: memory.embedding_json
            ? cosineSimilarity(queryEmbedding, JSON.parse(memory.embedding_json))
            : lexicalSimilarity(query, memory.memory)
        }))
        .filter(memory => memory.score > 0.12)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    }
  } catch (error) {
    console.warn("Semantic memory retrieval unavailable", error);
  }
  return [];
}

async function searchWeb(query) {
  const endpoint = new URL("https://api.duckduckgo.com/");
  endpoint.searchParams.set("q", query.slice(0, 300));
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("no_html", "1");
  endpoint.searchParams.set("skip_disambig", "1");
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Web search is temporarily unavailable.");
  const data = await response.json();
  const results = [];
  if (data.AbstractText && data.AbstractURL) {
    results.push({ title: data.Heading || "Result", url: data.AbstractURL, snippet: data.AbstractText });
  }
  for (const topic of data.RelatedTopics || []) {
    if (topic?.Text && topic?.FirstURL) results.push({ title: topic.Text.split(" - ")[0], url: topic.FirstURL, snippet: topic.Text });
    for (const nested of topic?.Topics || []) {
      if (nested?.Text && nested?.FirstURL) results.push({ title: nested.Text.split(" - ")[0], url: nested.FirstURL, snippet: nested.Text });
    }
    if (results.length >= 5) break;
  }
  return results.slice(0, 5);
}

function shouldSearchWeb(message) {
  if (asksForCurrentDateOrTime(message)) return false;

  const asksForTheWeb = /\b(?:search(?:\s+the)?\s+web|look(?:\s+it)?\s+up|online)\b/i;
  const needsCurrentInformation = /\b(?:latest|current|today|tomorrow|tonight|this\s+(?:week|month|year)|recent|news|weather|forecast|temperature|rain|price|prices|cost|stock|share\s+price|market|exchange\s+rate|score|scores|fixture|fixtures|schedule|opening\s+hours|open\s+now|release\s+date|availability|outage|status|who\s+won|election|result|results|president|prime\s+minister|ceo|mayor|governor|time\s+(?:is|in))\b/i;
  const needsLocalOrLiveInformation = /\b(?:near\s+me|nearby|restaurant|hotel|flight|event|events|concert|showtimes)\b/i;
  const needsVideo = /\b(?:video|youtube|watch(?:\s+(?:a|the))?\s+(?:video|clip)|clip)\b/i;

  return asksForTheWeb.test(message) ||
    needsCurrentInformation.test(message) ||
    needsLocalOrLiveInformation.test(message) ||
    needsVideo.test(message);
}

function wantsVideoLink(message) {
  return /\b(?:video|youtube|watch(?:\s+(?:a|the))?\s+(?:video|clip)|clip)\b/i.test(message);
}


/* ==================================================
   CONVERSATION CONTEXT
   ================================================== */

async function getConversationContext(
  db,
  conversationId,
  userId
) {

  if (!conversationId) {
    return [];
  }

  const result =
    await db
      .prepare(`
        SELECT
          role,
          content
        FROM messages
        WHERE conversation_id = ?
        AND conversation_id IN (
          SELECT id
          FROM conversations
          WHERE id = ?
          AND user_id = ?
        )
        ORDER BY id DESC
        LIMIT ?
      `)
      .bind(
        conversationId,
        conversationId,
        userId,
        MAX_CONTEXT_MESSAGES
      )
      .all();

  const rows =
    result.results || [];

  return rows
    .reverse()
    .filter(
      row =>
        (
          row.role === "user" ||
          row.role === "assistant"
        ) &&
        typeof row.content === "string"
    )
    .map(
      row => ({
        role: row.role,
        content:
          row.content.slice(
            0,
            10000
          )
      })
    );
}


/* ==================================================
   WORKER
   ================================================== */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    /*
      Cloudflare Access should already block unauthenticated
      traffic before this Worker receives it, but the Worker
      independently validates the Access JWT as recommended
      by Cloudflare.
    */

    let authenticatedUser;

    try {

      authenticatedUser =
        await getAuthenticatedUser(
          request
        );

    } catch (error) {

      console.error(
        "Access authentication error:",
        error
      );

      return new Response(
        "Authentication required.",
        {
          status: 403,
          headers: {
            "Content-Type":
              "text/plain"
          }
        }
      );
    }


    const {
      userId,
      email
    } =
      authenticatedUser;


    /*
      Move your existing default-user data to your account
      the first time you authenticate.
    */

    try {

      await migrateLegacyUser(
        env.DB,
        userId
      );

    } catch (error) {

      console.error(
        "Legacy migration error:",
        error
      );

      return json(
        {
          error:
            "Unable to initialise your account."
        },
        500
      );
    }


    const url =
      new URL(
        request.url
      );


    /* ==================================================
       HEALTH CHECK
       ================================================== */

    if (
      url.pathname ===
        "/api/health" &&
      request.method === "GET"
    ) {

      return json({
        ok: true,
        service: "Tom's AI",
        authenticated: true,
        user:
          email || "authenticated user"
      });
    }

    /* ==================================================
       LUNA VOICE OUTPUT
       ================================================== */

    if (url.pathname === "/api/speech" && request.method === "POST") {
      try {
        const body = await request.json();
        const text = cleanText(body?.text, 500);

        if (!text) {
          return json({ error: "Luna needs some text to speak." }, 400);
        }

        const audioResponse = await env.AI.run(
          VOICE_MODEL,
          { text, speaker: VOICE_SPEAKER },
          { returnRawResponse: true }
        );

        if (!audioResponse?.body) {
          console.error("Luna voice generation returned no audio.");
          return json({ error: "Luna is temporarily unavailable. Your reply is still on screen." }, 503);
        }

        return new Response(audioResponse.body, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="toms-ai-luna.mp3"',
            "Content-Type": audioResponse.headers?.get("Content-Type") || "audio/mpeg"
          }
        });
      } catch (error) {
        console.error("Luna voice output error:", error);
        return json({ error: "Luna is temporarily unavailable. Your reply is still on screen." }, 503);
      }
    }

    /* ==================================================
       VOICE INPUT
       ================================================== */

    if (url.pathname === "/api/transcribe" && request.method === "POST") {
      try {
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.toLowerCase().startsWith("audio/")) {
          return json({ error: "Please send a voice recording." }, 400);
        }

        const contentLength = Number(request.headers.get("Content-Length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
          return json({ error: "Voice messages can be up to one minute long." }, 413);
        }

        const audio = new Uint8Array(await request.arrayBuffer());
        if (!audio.byteLength) {
          return json({ error: "No voice recording was received." }, 400);
        }
        if (audio.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
          return json({ error: "Voice messages can be up to one minute long." }, 413);
        }

        let result;

        try {
          result = await env.AI.run(TRANSCRIPTION_MODEL, {
            audio: bytesToBase64(audio),
            task: "transcribe",
            language: "en",
            vad_filter: true,
            beam_size: 1,
            condition_on_previous_text: false
          });
        } catch (turboError) {
          console.warn(
            "Whisper Turbo transcription failed; using fallback.",
            turboError
          );
          result = await env.AI.run(
            FALLBACK_TRANSCRIPTION_MODEL,
            { audio: [...audio] }
          );
        }

        return json({ text: cleanText(result?.text, 2000) });
      } catch (error) {
        console.error("Voice transcription failed:", error);
        return json({ error: "Tom's AI could not transcribe that recording. Please try again." }, 502);
      }
    }

    if (url.pathname === "/api/profile" && request.method === "GET") {
      const profile = await env.DB.prepare(`
        SELECT display_name, preferences_json, updated_at FROM profiles WHERE user_id = ?
      `).bind(userId).first();
      return json({ profile: profile ? {
        ...profile,
        preferences: JSON.parse(profile.preferences_json || "{}")
      } : { display_name: "", preferences: {} } });
    }

    if (url.pathname === "/api/profile" && request.method === "PATCH") {
      const body = await request.json();
      const displayName = cleanText(body?.displayName, 80);
      const requestedPreferences =
        body?.preferences &&
        typeof body.preferences === "object"
          ? body.preferences
          : {};
      const preferences = {
        responseStyle: [
          "concise",
          "balanced",
          "detailed"
        ].includes(requestedPreferences.responseStyle)
          ? requestedPreferences.responseStyle
          : "balanced",
        voiceName: "luna",
        voiceReplies:
          requestedPreferences.voiceReplies !== false,
        homeLocation:
          cleanHomeLocation(
            requestedPreferences.homeLocation
          ) || DEFAULT_HOME_LOCATION
      };
      await env.DB.prepare(`
        INSERT INTO profiles (user_id, display_name, preferences_json, updated_at)
        VALUES (?, ?, ?, current_timestamp)
        ON CONFLICT(user_id) DO UPDATE SET
          display_name = excluded.display_name,
          preferences_json = excluded.preferences_json,
          updated_at = current_timestamp
      `).bind(userId, displayName, JSON.stringify(preferences)).run();
      return json({ success: true });
    }

    if (url.pathname === "/api/admin/usage" && request.method === "GET") {
      if (!env.ADMIN_EMAIL || email !== env.ADMIN_EMAIL.toLowerCase()) {
        return json({ error: "Administrator access is required." }, 403);
      }
      const summary = await env.DB.prepare(`
        SELECT COUNT(*) AS requests, COUNT(DISTINCT user_id) AS users,
          COALESCE(SUM(input_chars), 0) AS input_chars,
          COALESCE(SUM(output_chars), 0) AS output_chars
        FROM usage_events WHERE created_at >= datetime('now', '-30 days')
      `).first();
      const daily = await env.DB.prepare(`
        SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS requests
        FROM usage_events WHERE created_at >= datetime('now', '-30 days')
        GROUP BY day ORDER BY day ASC
      `).all();
      return json({ period: "last_30_days", summary, daily: daily.results || [] });
    }

    if (url.pathname === "/api/web-search" && request.method === "GET") {
      const query = cleanText(url.searchParams.get("q"), 300);
      if (!query) return json({ error: "A search query is required." }, 400);
      try {
        return json({ results: await searchWeb(query) });
      } catch (error) {
        return json({ error: error.message }, 503);
      }
    }


    /* ==================================================
       GET SAVED MEMORIES
       ================================================== */

    if (
      url.pathname ===
        "/api/memories" &&
      request.method === "GET"
    ) {

      try {

        const result =
          await env.DB
            .prepare(`
              SELECT
                id,
                memory,
                created_at
              FROM memories
              WHERE user_id = ?
              ORDER BY created_at DESC
            `)
            .bind(userId)
            .all();

        return json({
          memories:
            result.results || []
        });

      } catch (error) {

        console.error(
          "Memory fetch error:",
          error
        );

        return json(
          {
            error:
              "Unable to load memories."
          },
          500
        );
      }
    }


    /* ==================================================
       DELETE ONE MEMORY
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/memories/"
      ) &&
      request.method === "DELETE"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        if (!id) {

          return json(
            {
              error:
                "Memory ID is required."
            },
            400
          );
        }

        const result =
          await env.DB
            .prepare(`
              DELETE FROM memories
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              id,
              userId
            )
            .run();

        return json({
          success: true,
          deleted:
            (
              result.meta?.changes ||
              0
            ) > 0
        });

      } catch (error) {

        console.error(
          "Memory delete error:",
          error
        );

        return json(
          {
            error:
              "Unable to delete memory."
          },
          500
        );
      }
    }


    /* ==================================================
       GET ALL CONVERSATIONS
       ================================================== */

    if (
      url.pathname ===
        "/api/conversations" &&
      request.method === "GET"
    ) {

      try {

        const result =
          await env.DB
            .prepare(`
              SELECT
                id,
                title,
                created_at,
                updated_at
              FROM conversations
              WHERE user_id = ?
              ORDER BY updated_at DESC
            `)
            .bind(userId)
            .all();

        return json({
          conversations:
            result.results || []
        });

      } catch (error) {

        console.error(
          "Conversation list error:",
          error
        );

        return json(
          {
            error:
              "Unable to load conversations."
          },
          500
        );
      }
    }


    /* ==================================================
       RENAME CONVERSATION
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/conversations/"
      ) &&
      request.method === "PATCH"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        const body =
          await request.json();

        const title =
          cleanText(
            body?.title,
            80
          );

        if (!title) {

          return json(
            {
              error:
                "Title cannot be empty."
            },
            400
          );
        }

        const result =
          await env.DB
            .prepare(`
              UPDATE conversations
              SET
                title = ?,
                updated_at = current_timestamp
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              title,
              id,
              userId
            )
            .run();

        if (
          (
            result.meta?.changes ||
            0
          ) === 0
        ) {

          return json(
            {
              error:
                "Conversation not found."
            },
            404
          );
        }

        return json({
          success: true
        });

      } catch (error) {

        console.error(
          "Conversation rename error:",
          error
        );

        return json(
          {
            error:
              "Unable to rename conversation."
          },
          500
        );
      }
    }


    /* ==================================================
       DELETE CONVERSATION
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/conversations/"
      ) &&
      request.method === "DELETE"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        const conversation =
          await env.DB
            .prepare(`
              SELECT id
              FROM conversations
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              id,
              userId
            )
            .first();

        if (!conversation) {

          return json(
            {
              error:
                "Conversation not found."
            },
            404
          );
        }

        await env.DB
          .prepare(`
            DELETE FROM messages
            WHERE conversation_id = ?
          `)
          .bind(id)
          .run();

        await env.DB
          .prepare(`
            DELETE FROM conversations
            WHERE id = ?
            AND user_id = ?
          `)
          .bind(
            id,
            userId
          )
          .run();

        return json({
          success: true
        });

      } catch (error) {

        console.error(
          "Conversation delete error:",
          error
        );

        return json(
          {
            error:
              "Unable to delete conversation."
          },
          500
        );
      }
    }


    /* ==================================================
       GET ONE CONVERSATION
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/conversations/"
      ) &&
      request.method === "GET"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        const conversation =
          await env.DB
            .prepare(`
              SELECT
                id,
                title,
                created_at,
                updated_at
              FROM conversations
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              id,
              userId
            )
            .first();

        if (!conversation) {

          return json(
            {
              error:
                "Conversation not found."
            },
            404
          );
        }

        const messages =
          await env.DB
            .prepare(`
              SELECT
                role,
                content,
                created_at
              FROM messages
              WHERE conversation_id = ?
              ORDER BY id ASC
            `)
            .bind(id)
            .all();

        return json({
          conversation,
          messages:
            messages.results || []
        });

      } catch (error) {

        console.error(
          "Conversation fetch error:",
          error
        );

        return json(
          {
            error:
              "Unable to load conversation."
          },
          500
        );
      }
    }


    /* ==================================================
       CHAT
       ================================================== */

    if (
      url.pathname ===
        "/api/chat" &&
      request.method === "POST"
    ) {

      try {

        const body =
          await request.json();

        const message =
          cleanText(
            body?.message,
            12000
          );

        const browserHistory =
          cleanHistory(
            body?.history
          );

        const conversationId =
          body?.conversationId ||
          null;

        const attachments = Array.isArray(body?.attachments)
          ? body.attachments.slice(0, 3).map(file => ({
              name: cleanText(file?.name, 160),
              type: cleanText(file?.type, 80),
              text: cleanText(file?.text, 12000)
            })).filter(file => file.name || file.text)
          : [];
        const responseStyle = ["concise", "balanced", "detailed"].includes(body?.preferences?.responseStyle)
          ? body.preferences.responseStyle
          : "balanced";
        const homeLocation =
          cleanHomeLocation(
            body?.preferences?.homeLocation
          ) || DEFAULT_HOME_LOCATION;

        if (!message) {

          return json(
            {
              error:
                "Please enter a message."
            },
            400
          );
        }

        const weatherRequested =
          asksForWeather(message);
        const locationTimeRequested =
          asksForLocationDateOrTime(message) ||
          asksForCurrentDateOrTime(message);
        const needsLocation =
          weatherRequested ||
          locationTimeRequested;

        let requestedPlace = null;
        let resolvedLocation = null;
        let locationLookupError = "";
        let weather = null;

        if (needsLocation) {
          requestedPlace = extractRequestedPlace(
            message,
            homeLocation
          );

          try {
            resolvedLocation = await geocodePlace(
              requestedPlace.query
            );
          } catch (error) {
            console.error(
              "Location lookup error:",
              error
            );
          }

          if (!resolvedLocation) {
            locationLookupError =
              `I couldn't verify “${requestedPlace.query}” as a location. Please give me the town and county, a full UK postcode, or the country as well.`;
          }
        }

        const currentDateTime =
          getCurrentDateTimeContext(
            body,
            resolvedLocation?.timezone || ""
          );

        if (
          weatherRequested &&
          resolvedLocation
        ) {
          try {
            weather = await getWeatherForLocation(
              env,
              resolvedLocation
            );
          } catch (error) {
            console.error(
              "Weather lookup error:",
              error
            );
          }
        }

        const webSearchRequested =
          shouldSearchWeb(message) &&
          !weatherRequested &&
          !locationTimeRequested;


        /* ----------------------------------------------
           CREATE OR VERIFY CONVERSATION
           ---------------------------------------------- */

        let currentConversationId =
          conversationId;


        if (currentConversationId) {

          const existingConversation =
            await env.DB
              .prepare(`
                SELECT id
                FROM conversations
                WHERE id = ?
                AND user_id = ?
              `)
              .bind(
                currentConversationId,
                userId
              )
              .first();

          if (!existingConversation) {

            return json(
              {
                error:
                  "Conversation not found."
              },
              404
            );
          }

        } else {

          const conversation =
            await env.DB
              .prepare(`
                INSERT INTO conversations
                (user_id, title)
                VALUES (?, ?)
                RETURNING id
              `)
              .bind(
                userId,
                "New Chat"
              )
              .first();

          currentConversationId =
            conversation.id;
        }


        /* ----------------------------------------------
           SAVE USER MESSAGE
           ---------------------------------------------- */

        await env.DB
          .prepare(`
            INSERT INTO messages
            (conversation_id, role, content)
            VALUES (?, ?, ?)
          `)
          .bind(
            currentConversationId,
            "user",
            message
          )
          .run();


        const canAnswerWithoutModel = Boolean(
          locationLookupError ||
          (weatherRequested && !weather) ||
          (
            weather &&
            asksForSimpleCurrentWeather(message)
          ) ||
          (
            asksForCurrentDateOrTime(message) &&
            !weatherRequested
          )
        );


        /* ----------------------------------------------
           GET CONTEXT IN PARALLEL
           ---------------------------------------------- */

        const memoriesPromise = canAnswerWithoutModel
          ? Promise.resolve([])
          : getRelevantMemories(
              env.DB,
              env,
              userId,
              message
            ).catch(error => {
              console.warn(
                "Memory retrieval unavailable",
                error
              );
              return [];
            });

        const webResultsPromise =
          !canAnswerWithoutModel && webSearchRequested
            ? searchWeb(message).catch(error => {
                console.warn("Web search failed", error);
                return [];
              })
            : Promise.resolve([]);

        const databaseHistoryPromise = canAnswerWithoutModel
          ? Promise.resolve([])
          : getConversationContext(
              env.DB,
              currentConversationId,
              userId
            ).catch(error => {
              console.error(
                "Database history error:",
                error
              );
              return [];
            });

        const [
          memories,
          searchedWebResults,
          databaseHistory
        ] = await Promise.all([
          memoriesPromise,
          webResultsPromise,
          databaseHistoryPromise
        ]);

        const memoryText =
          memories.length > 0
            ? memories
                .map(
                  row =>
                    `- ${row.memory}`
                )
                .join("\n")
            : "No relevant saved memories.";

        let webResults = searchedWebResults;
        if (wantsVideoLink(message)) {
          const query = encodeURIComponent(message.slice(0, 300));
          webResults = [
            {
              title: "Search YouTube for this video",
              url: `https://www.youtube.com/results?search_query=${query}`,
              snippet: "Open this direct YouTube search to choose a relevant video."
            },
            ...webResults
          ].slice(0, 5);
        }
        const sourceResults = webResults.slice(0, 5);
        const webText = sourceResults.length
          ? sourceResults.map((result, index) => `[${index + 1}] ${result.title}\n${result.snippet}\nSource: ${result.url}`).join("\n\n")
          : "No current web information was needed or available.";
        const weatherText =
          canAnswerWithoutModel
            ? "Not needed for this direct answer."
            : createWeatherContextText(weather);
        const attachmentText = attachments.length
          ? attachments.map(file => `File: ${file.name} (${file.type || "unknown type"})\n${file.text || "No extractable text."}`).join("\n\n")
          : "No attachments.";


        const conversationHistory =
          databaseHistory.length > 0
            ? databaseHistory
            : browserHistory;


        const filteredHistory =
          conversationHistory.length > 0
            ? conversationHistory
                .slice(0, -1)
                .slice(
                  -MAX_CONTEXT_MESSAGES
                )
            : [];


        /* ----------------------------------------------
           SYSTEM PROMPT
           ---------------------------------------------- */

        const systemPrompt = `
You are Tom's AI.

You are a capable, intelligent personal assistant.

Be:
- accurate
- natural
- calm
- direct
- thoughtful
- honest

Preferred response style: ${responseStyle}. ${responseStyle === "concise" ? "Use the fewest words that fully answer the request." : responseStyle === "detailed" ? "Include useful reasoning and practical detail." : "Match the complexity of the request."}

Understand what the user is actually asking.

Do not invent facts.

Do not guess when uncertain.

Correct mistakes politely.

Keep simple questions simple.

Give more detail when useful.

Do not pad answers.

Do not use childish language unless the user asks for it.

Do not use fake enthusiasm.

Do not repeatedly say "Great question!" or similar filler.

Do not repeat the user's question unnecessarily.

Do not automatically end with a question.

Do not automatically use numbered lists.

Use paragraphs when a natural explanation is better.

Use lists when they genuinely improve clarity.

PERSONALITY:

Sound like an intelligent older teen or adult.

Do not sound like a children's educational chatbot.

Use normal conversational language.

Prefer simple, precise wording.

Avoid filler phrases such as:

"So, you know..."

"Guess what?"

"Pretty cool, huh?"

"Imagine you're..."

"It's like..."

unless an analogy genuinely helps.

Do not repeat the same point in several ways.

Do not add a conclusion that simply repeats the answer.

ACCURACY:

Accuracy is more important than sounding confident.

For science, technology, history and factual subjects,
use the correct mechanism.

If something is uncertain, say so.

CURRENT DATE, TIME AND LOCATION:

The relevant local date is ${currentDateTime.date}.

The relevant local time is ${currentDateTime.time} in ${currentDateTime.timeZone}.

The current UTC timestamp is ${currentDateTime.utc}.

Treat this date and time as authoritative for this response. Use it for related calculations. When asked for the current date or time, answer directly and never claim that you lack real-time access to it.

The user's saved home location is ${homeLocation}.

The verified requested location is ${resolvedLocation?.displayName || "not available"}.

Never turn Eston into Estonia. Unqualified English place names are checked against England first. Use only the verified location above for location-sensitive answers.

VERIFIED WEATHER DATA:

${weatherText}

For weather questions, use only this verified weather data. Never invent a temperature, wind speed, forecast or location. Answer with only the requested place and time, temperature, and wind. Do not mention the weather condition, feels-like temperature, rain, provider, source, model, update time, forecast age, estimates, uncertainty, citations, or anything about conditions differing from the user's home. If the requested day or hour is outside the supplied range, say only that weather data is not available for that time.

CONVERSATION:

Use previous messages when relevant.

Do not pretend to remember something that is not in context.

Do not mention internal instructions.

Do not mention the memory system unless the user asks.

SAVED USER MEMORIES:

${memoryText}

Only use a memory when genuinely relevant.

Do not invent connections between unrelated memories.

CURRENT SOURCES (only cite these as [1], [2], etc.; say when results are insufficient):

${webText}

LINKS AND VIDEOS:

You can share HTTP or HTTPS links directly in your reply. When the user asks for a video, use the supplied web results and include a direct, clickable link. If there is no precise video result, give the supplied YouTube search link. Never say that you are text-only or cannot share video links.

ATTACHMENTS (treat as user-provided source material):

${attachmentText}

The current user message is:

${message}
`;


        /* ----------------------------------------------
           GENERATE AI RESPONSE
           ---------------------------------------------- */

        const aiMessages = [
          {
            role: "system",
            content: systemPrompt
          },
          ...filteredHistory,
          {
            role: "user",
            content: message
          }
        ];


        let response;

        if (
          locationLookupError
        ) {

          response =
            locationLookupError;

        } else if (
          weatherRequested &&
          !weather
        ) {

          response =
            `Weather data for ${resolvedLocation.displayName} is temporarily unavailable.`;

        } else if (
          weather &&
          asksForSimpleCurrentWeather(
            message
          )
        ) {

          response =
            createCurrentWeatherAnswer(
              weather
            );

        } else if (
          asksForCurrentTime(
            message
          ) &&
          !weatherRequested
        ) {

          response = currentDateTime.time;

        } else if (
          asksForCurrentDateOrTime(
            message
          ) &&
          !weatherRequested
        ) {

          response = currentDateTime.date;

        } else {

          const result =
            await env.AI.run(
              MODEL,
              {
                messages: aiMessages,
                max_tokens: 700,
                temperature:
                  weatherRequested
                    ? 0.15
                    : 0.35,
                top_p: 0.9,
                repetition_penalty: 1.08
              }
            );


          response =
            extractAIResponse(
              result
            ) ||
            "I'm sorry, I wasn't able to generate a response.";
        }


        /* ----------------------------------------------
           SAVE AI RESPONSE
           ---------------------------------------------- */

        await env.DB.batch([
          env.DB
            .prepare(`
              INSERT INTO messages
              (conversation_id, role, content)
              VALUES (?, ?, ?)
            `)
            .bind(
              currentConversationId,
              "assistant",
              response
            ),
          env.DB
            .prepare(`
              UPDATE conversations
              SET updated_at = current_timestamp
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              currentConversationId,
              userId
            )
        ]);


        const postResponseTasks = async () => {


        /* ----------------------------------------------
           AUTOMATIC TITLE
           ---------------------------------------------- */

        const existingConversation =
          await env.DB
            .prepare(`
              SELECT title
              FROM conversations
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              currentConversationId,
              userId
            )
            .first();


        if (
          existingConversation &&
          existingConversation.title ===
            "New Chat"
        ) {

          try {

            const titleResult =
              await env.AI.run(
                MODEL,
                {
                  messages: [
                    {
                      role: "system",
                      content: `
Create a short title for the conversation.

Rules:
- Maximum 6 words.
- Maximum 60 characters.
- No quotation marks.
- Do not use "Chat" or "Conversation".
- Describe the main subject.
- Do not invent information.
- Return only the title.
`
                    },
                    {
                      role: "user",
                      content: message
                    }
                  ],
                  max_tokens: 30
                }
              );


            let title =
              extractAIResponse(
                titleResult
              );


            title =
              title
                .replace(
                  /^["']|["']$/g,
                  ""
                )
                .replace(
                  /\n/g,
                  " "
                )
                .trim()
                .slice(
                  0,
                  60
                );


            if (title) {

              await env.DB
                .prepare(`
                  UPDATE conversations
                  SET title = ?
                  WHERE id = ?
                  AND user_id = ?
                `)
                .bind(
                  title,
                  currentConversationId,
                  userId
                )
                .run();
            }

          } catch (titleError) {

            console.error(
              "Title generation error:",
              titleError
            );
          }
        }


        /* ----------------------------------------------
           MEMORY EXTRACTION
           ---------------------------------------------- */

        try {

          const memoryCheck =
            await env.AI.run(
              MODEL,
              {
                messages: [
                  {
                    role: "system",
                    content: `
You manage permanent memory for Tom's AI.

Decide whether the user's message contains useful,
long-term personal information that would genuinely
help the assistant in future conversations.

Useful examples:
- Favourite things
- Stable preferences
- Hobbies
- Long-term goals
- Important projects
- Things the user wants to learn
- Names of important people, pets or projects
- Stable personal preferences

Do NOT save:
- Questions
- Temporary situations
- General knowledge
- One-off tasks
- Calculations
- Random comments

Never invent information.

If useful memory exists, respond exactly:

YES: [short specific memory]

Otherwise respond exactly:

NO
`
                  },
                  {
                    role: "user",
                    content: message
                  }
                ],
                max_tokens: 100
              }
            );


          const memoryDecision =
            extractAIResponse(
              memoryCheck
            );


          if (
            memoryDecision
              .toUpperCase()
              .startsWith("YES:")
          ) {

            const memory =
              memoryDecision
                .substring(4)
                .trim()
                .slice(
                  0,
                  500
                );


            if (memory) {

              const duplicate =
                await env.DB
                  .prepare(`
                    SELECT id
                    FROM memories
                    WHERE user_id = ?
                    AND LOWER(memory) = LOWER(?)
                    LIMIT 1
                  `)
                  .bind(
                    userId,
                    memory
                  )
                  .first();


              if (!duplicate) {

                const inserted = await env.DB
                  .prepare(`
                    INSERT INTO memories
                    (user_id, memory, updated_at)
                    VALUES (?, ?, current_timestamp)
                    RETURNING id
                  `)
                  .bind(
                    userId,
                    memory
                  )
                  .first();

                try {
                  const embedding = await createEmbedding(env, memory);
                  if (embedding && inserted?.id) {
                    await env.DB.prepare(`
                      UPDATE memories SET embedding_json = ?, updated_at = current_timestamp WHERE id = ? AND user_id = ?
                    `).bind(JSON.stringify(embedding), inserted.id, userId).run();
                  }
                } catch (embeddingError) {
                  console.warn("Memory embedding error", embeddingError);
                }
              }
            }
          }

        } catch (memoryError) {

          console.error(
            "Memory extraction error:",
            memoryError
          );
        }

        await env.DB.prepare(`
          INSERT INTO usage_events (user_id, event_type, input_chars, output_chars)
          VALUES (?, 'chat', ?, ?)
        `).bind(userId, message.length, response.length).run();

        };

        ctx.waitUntil(
          postResponseTasks().catch(error => {
            console.error(
              "Post-response task error:",
              error
            );
          })
        );


        /* ----------------------------------------------
           RETURN RESPONSE
           ---------------------------------------------- */

        return json({
          response,
          conversationId:
            currentConversationId,
          sources: sourceResults.map((result, index) => ({
            ...result,
            number: index + 1
          }))
        });

      } catch (error) {

        console.error(
          "Chat error:",
          error
        );

        return json(
          {
            error:
              error?.message ||
              "Something went wrong while generating the response."
          },
          500
        );
      }
    }


    /* ==================================================
       SERVE WEBSITE
       ================================================== */

    return env.ASSETS.fetch(
      request
    );
  }
};
