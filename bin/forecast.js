'use strict';
// Gismeteo feed parser written for AJAZZ Stream Dock. No Home Assistant dependency.
const BASE = 'https://services.gismeteo.ru/inform-service/inf_chrome';
const DEFAULT_TTL = 30 * 60 * 1000;
const TIMEOUT = 13000;
const MAX_XML = 3 * 1024 * 1024;

function decodeXml(value = '') {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (raw, key) => {
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return "'";
    if (key.startsWith('#')) {
      const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
    }
    return raw;
  });
}
function attrs(tag = '') {
  const out = {};
  const head = tag.indexOf(' ');
  if (head < 0) return out;
  const content = tag.slice(head);
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(content))) out[match[1]] = decodeXml(match[2] ?? match[3]);
  return out;
}
function firstTag(xml, tag) {
  return xml.match(new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, 'i'))?.[0] || '';
}
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function val(data, key) { return num(data[key]); }
function valuesOf(block) { return attrs(firstTag(block, 'values')); }
function blocks(xml, tag) {
  const result = [];
  const re = new RegExp(`<${tag}(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
  let match;
  while ((match = re.exec(xml))) result.push(match[0]);
  return result;
}
function localDate(stamp) {
  // Do not interpret location-local dates as PC-local dates.
  return typeof stamp === 'string' ? stamp.slice(0, 10) : '';
}
function parsedValues(a, ts = null) {
  return {
    time: ts,
    temperature: val(a, 'tflt') ?? val(a, 't'),
    pressure: val(a, 'p'),
    humidity: val(a, 'hum'),
    windSpeed: val(a, 'ws'),
    windDirectionCode: val(a, 'wd'),
    cloud: val(a, 'cl'),
    precipType: val(a, 'pt'),
    precipAmount: val(a, 'prflt'),
    precipIntensity: val(a, 'pr'),
    thunder: a.ts === '1',
    magnetic: val(a, 'grade'),
    phenomenon: val(a, 'ph'),
    waterTemperature: val(a, 'water_t'),
    description: a.descr || null,
  };
}
function nightFromSun(ts, sunrise, sunset, timezoneMinutes = 0) {
  let timestamp = ts;
  // XML valid timestamps can be either RFC3339 or local wall-clock without an offset.
  if (typeof ts === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(ts)) {
    const offset = Number(timezoneMinutes || 0);
    const abs = Math.abs(offset);
    timestamp = ts + (offset < 0 ? '-' : '+') + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
  }
  const t = Date.parse(timestamp);
  if (Number.isFinite(t) && sunrise && sunset) return t < sunrise * 1000 || t >= sunset * 1000;
  return false;
}
function condition(data, night = false) {
  if (!data) return 'unknown';
  if (data.thunder) return 'thunder';
  if (data.precipType === 1) return data.precipIntensity === 3 ? 'heavy-rain' : 'rain';
  if (data.precipType === 2) return 'snow';
  if (data.precipType === 3) return 'sleet';
  if (data.cloud === 0 && [11,12,28,40,41,42,43,44,45,46,47,48,49,120,130,131,132,133,134,135,528].includes(data.phenomenon)) return 'fog';
  if (data.windSpeed != null && data.windSpeed > 10.8) return 'wind';
  if (data.cloud === 0) return night ? 'clear-night' : 'sunny';
  if (data.cloud === 1 || data.cloud === 2) return night ? 'partly-night' : 'partly';
  if (data.cloud != null) return 'cloudy';
  return 'unknown';
}
function feelsLike(temp, humidity, windSpeed) {
  if ([temp, humidity, windSpeed].some(x => x == null)) return null;
  // Same published apparent-temperature approach as the reference HA integration.
  const e = humidity * .06105 * Math.exp(17.27 * temp / (237.7 + temp));
  return Math.round((temp + .348 * e - .7 * windSpeed - 4.25) * 10) / 10;
}
function parseCity(xml) {
  const a = attrs(firstTag(xml, 'item'));
  const id = num(a.id);
  if (!id || !Number.isInteger(id)) throw new Error('Город не найден по координатам');
  return { id, latitude: num(a.lat), longitude: num(a.lng), name: a.name || a.title || '' };
}
function parseForecast(xml) {
  if (typeof xml !== 'string' || !xml.includes('<location')) throw new Error('Неверный ответ Gismeteo');
  const loc = attrs(firstTag(xml, 'location'));
  const currentBlock = blocks(xml, 'fact')[0] || '';
  if (!currentBlock) throw new Error('Нет текущей погоды в XML');
  const fact = attrs(firstTag(currentBlock, 'fact'));
  const today = parsedValues(valuesOf(currentBlock), fact.valid || loc.cur_time || null);
  const sunrise = num(fact.sunrise);
  const sunset = num(fact.sunset);
  today.sunrise = sunrise;
  today.sunset = sunset;
  today.icon = condition(today, nightFromSun(today.time, sunrise, sunset, loc.tzone));
  today.feelsLike = feelsLike(today.temperature, today.humidity, today.windSpeed);
  const daily = [];
  const hourly = [];
  for (const dayBlock of blocks(xml, 'day')) {
    const day = attrs(firstTag(dayBlock, 'day'));
    const sunriseDay = num(day.sunrise), sunsetDay = num(day.sunset);
    for (const forecastBlock of blocks(dayBlock, 'forecast')) {
      const f = attrs(firstTag(forecastBlock, 'forecast'));
      const hour = parsedValues(valuesOf(forecastBlock), f.valid || null);
      hour.sunrise = sunriseDay;
      hour.sunset = sunsetDay;
      hour.icon = condition(hour, nightFromSun(hour.time, sunriseDay, sunsetDay, loc.tzone));
      hourly.push(hour);
    }
    if (day.descr != null || day.tmax != null || day.tmin != null) {
      const d = parsedValues(day, day.date || null);
      d.temperature = num(day.tmax);
      d.lowTemperature = num(day.tmin);
      d.magnetic = num(day.grademax) ?? d.magnetic;
      d.sunrise = sunriseDay;
      d.sunset = sunsetDay;
      d.icon = condition(d, false);
      d.feelsLike = feelsLike(d.temperature, d.humidity, d.windSpeed);
      const pressures = hourly.filter(h => localDate(h.time) === localDate(d.time) && h.pressure != null).map(h => h.pressure);
      if (pressures.length) d.pressure = Math.round(pressures.reduce((a,b) => a + b, 0) / pressures.length);
      daily.push(d);
    }
  }
  return { current: today, daily, hourly, location: loc, receivedAt: Date.now() };
}
function safeFetch(url, timeoutMs = TIMEOUT) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/xml, application/json;q=0.9, text/xml;q=0.8, */*;q=0.1', 'User-Agent': 'DruidblackGismeteoWeather/1.1 (AJAZZ Stream Dock)' }, redirect: 'error' })
    .then(async r => {
      if (!r.ok) throw new Error(`Gismeteo HTTP ${r.status}`);
      const length = Number(r.headers.get('content-length') || 0);
      if (length > MAX_XML) throw new Error('Ответ Gismeteo слишком большой');
      const body = await r.text();
      if (body.length > MAX_XML) throw new Error('Ответ Gismeteo слишком большой');
      return body;
    }).finally(() => clearTimeout(timeout));
}
function parseId(source) {
  const raw = String(source || '').trim();
  if (!raw) return null;
  if (/^\d{1,10}$/.test(raw)) return Number(raw);
  // Both current weather-city-4368 and legacy /city/daily/4368 URLs.
  const modern = raw.match(/(?:^|\/)weather-[^/?#]*?-(\d{1,10})(?:\/|[?#]|$)/i);
  if (modern) return Number(modern[1]);
  const legacy = raw.match(/(?:^|\/)city\/(?:daily|weekly|hourly|month)\/(\d{1,10})(?:\/|[?#]|$)/i);
  return legacy ? Number(legacy[1]) : null;
}
function normalizeLocation(settings = {}) {
  const source = String(settings.cityId ?? '').trim();
  const id = parseId(source) || parseId(settings.cityLabel);
  if (id && Number.isSafeInteger(id) && id > 0) return { key: `id:${id}`, city: id };
  if (source && /^https?:\/\//i.test(source)) {
    throw new Error('Не удалось определить ID из ссылки. Укажите полный адрес города Gismeteo или номер города.');
  }
  const latText = String(settings.latitude ?? '').trim(), lonText = String(settings.longitude ?? '').trim();
  if (latText || lonText) {
    if (!latText || !lonText) throw new Error('Для поиска по координатам укажите широту и долготу.');
    const lat = num(latText.replace(',', '.')), lon = num(lonText.replace(',', '.'));
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('Некорректные координаты: широта от −90 до 90, долгота от −180 до 180.');
    }
    return { key: `geo:${lat.toFixed(4)}:${lon.toFixed(4)}`, latitude: lat, longitude: lon };
  }
  // The first text field is now a real location selector, not just a caption.
  const name = (source || String(settings.cityLabel ?? '')).trim();
  if (name) {
    if (name.length > 120) throw new Error('Название города слишком длинное.');
    return { key: `name:${name.toLocaleLowerCase('ru-RU')}`, name };
  }
  return null;
}
function parseGeocodingResponse(body) {
  let result;
  try { result = JSON.parse(body); }
  catch (_) { throw new Error('Сервис поиска городов вернул неверный ответ.'); }
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('Город не найден по названию. Введите «Город, страна» или вставьте ссылку Gismeteo.');
  }
  const lat = num(result[0].lat), lon = num(result[0].lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('Поиск города не вернул координаты.');
  }
  return { latitude: lat, longitude: lon, name: result[0].display_name || '' };
}
class WeatherProvider {
  constructor(load = safeFetch, ttl = DEFAULT_TTL) {
    this.load = load;
    this.ttl = ttl;
    this.cache = new Map();
    this.inflight = new Map();
    this.resolvedCities = new Map();
    this.failures = new Map();
    this.geocodeQueue = Promise.resolve();
    this.lastGeocodeAt = 0;
  }
  async geocode(name) {
    // Respect the public Nominatim one-request-per-second usage limit.
    const job = this.geocodeQueue.then(async () => {
      const wait = Math.max(0, 1100 - (Date.now() - this.lastGeocodeAt));
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      this.lastGeocodeAt = Date.now();
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(name);
      return parseGeocodingResponse(await this.load(url));
    });
    this.geocodeQueue = job.then(() => undefined, () => undefined);
    return job;
  }
  async loadCity(loc) {
    if (loc.city) return loc.city;
    if (this.resolvedCities.has(loc.key)) return this.resolvedCities.get(loc.key);
    let coords = loc;
    if (loc.name) {
      // Nominatim resolves human-readable places; forecasts still come only
      // from Gismeteo. Resolve only once per name, cache for the session.
      coords = await this.geocode(loc.name);
    }
    const url = `${BASE}/cities/?lat=${encodeURIComponent(coords.latitude)}&lng=${encodeURIComponent(coords.longitude)}&count=1&lang=en`;
    const city = parseCity(await this.load(url)).id;
    this.resolvedCities.set(loc.key, city);
    return city;
  }
  async get(loc, force = false) {
    if (!loc) throw new Error('Укажите город в настройках');
    const cached = this.cache.get(loc.key);
    const age = cached ? Date.now() - cached.receivedAt : Infinity;
    if (cached && age < (force ? 60 * 1000 : this.ttl)) return cached;
    const failure = this.failures.get(loc.key);
    if (failure && Date.now() - failure.at < (force ? 60 * 1000 : 5 * 60 * 1000)) {
      if (cached && age < 24 * 60 * 60 * 1000) return { ...cached, stale: true, error: failure.message };
      throw new Error(failure.message);
    }
    if (this.inflight.has(loc.key)) return this.inflight.get(loc.key);
    const promise = (async () => {
      try {
        const city = await this.loadCity(loc);
        const xml = await this.load(`${BASE}/forecast/?city=${encodeURIComponent(city)}&lang=en`);
        const forecast = parseForecast(xml);
        forecast.locationCode = city;
        this.cache.set(loc.key, forecast);
        this.failures.delete(loc.key);
        return forecast;
      } catch (err) {
        this.failures.set(loc.key, { at: Date.now(), message: err.message });
        // Don't wipe the last good forecast on temporary network errors.
        if (cached && age < 24 * 60 * 60 * 1000) return { ...cached, stale: true, error: err.message };
        throw err;
      } finally { this.inflight.delete(loc.key); }
    })();
    this.inflight.set(loc.key, promise);
    return promise;
  }
}
module.exports = { WeatherProvider, normalizeLocation, parseForecast, parseCity, parseId, parseGeocodingResponse, condition, feelsLike, attrs };
