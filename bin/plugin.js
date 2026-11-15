'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { LocalWS } = require('./ws-local');
const { WeatherProvider, normalizeLocation } = require('./forecast');
const ACTION = 'com.druidblack.streamdock.gismeteo.';
const args = {};
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i].startsWith('-')) args[process.argv[i].replace(/^-+/, '')] = process.argv[++i];
}
const port = Number(args.port), uuid = args.pluginUUID;
if (require.main === module && (!(port > 0 && port <= 65535) || !uuid)) {
  console.error('AJAZZ Stream Dock needs -port PORT -pluginUUID UUID');
  process.exit(2);
}
const provider = new WeatherProvider();
const contexts = new Map();
const images = new Map();
let socket = null;
let closing = false;
const logFile = path.resolve(__dirname, '../logs/gismeteo.log');
function log(text) {
  const msg = `${new Date().toISOString()} ${String(text)}\n`;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, msg);
  } catch (_) { console.error(msg); }
}
function image(name) {
  const key = (name || 'unknown').replace(/[^a-z0-9-]/gi, '');
  if (!images.has(key)) {
    try { images.set(key, 'data:image/png;base64,' + fs.readFileSync(path.resolve(__dirname, `../icons/${key}.png`)).toString('base64')); }
    catch (_) { return key === 'unknown' ? '' : image('unknown'); }
  }
  return images.get(key);
}
function send(msg) { if (socket?.open) socket.send(msg); }
function show(context, type, payload) { send({ event: type, context, payload }); }
function cleanLabel(s, size = 14) { return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, size); }
function signed(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '—';
  const num = Number(n.toFixed(digits));
  return (num > 0 ? '+' : '') + String(num).replace('.', ',');
}
function normal(n, digits = 0) { return n == null || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(digits))).replace('.', ','); }
function timeInLocation(seconds, offset) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  // Epoch seconds represent UTC. Shift by the supplied Gismeteo offset, not host PC timezone.
  const mins = Number(offset || 0);
  return new Date((seconds + (Number.isFinite(mins) ? mins * 60 : 0)) * 1000).toISOString().slice(11,16);
}
function windName(code) { return ['—','С','СВ','В','ЮВ','Ю','ЮЗ','З','СЗ'][code] || '—'; }
const metricFields = {
  temp: { icon: 'thermo', label: 'Температура', format: d => `${signed(d.temperature)}°` },
  feels: { icon: 'thermo', label: 'Ощущается', format: d => `${signed(d.feelsLike,1)}°` },
  humidity: { icon: 'humidity', label: 'Влажность', format: d => `${normal(d.humidity)}%` },
  pressure: { icon: 'pressure', label: 'Давление', format: d => `${normal(d.pressure)} мм` },
  wind: { icon: 'wind', label: 'Ветер', format: d => `${normal(d.windSpeed,1)} м/с` },
  direction: { icon: 'wind', label: 'Ветер', format: d => windName(d.windDirectionCode) },
  clouds: { icon: 'cloudy', label: 'Облачность', format: d => d.cloud == null ? '—' : ['Ясно','Мало','Облачно','Пасмурно'][d.cloud] || `${d.cloud}` },
  precipitation: { icon: 'rain', label: 'Осадки', format: d => d.precipAmount == null ? '—' : `${normal(d.precipAmount,1)} мм` },
  magnetic: { icon: 'magnetic', label: 'Геомагн.', format: d => normal(d.magnetic) },
  sunrise: { icon: 'sunny', label: 'Восход', format: (d,f) => timeInLocation(d.sunrise, f.location?.tzone) },
  sunset: { icon: 'clear-night', label: 'Закат', format: (d,f) => timeInLocation(d.sunset, f.location?.tzone) },
  water: { icon: 'humidity', label: 'Вода', format: d => d.waterTemperature == null ? '—' : `${signed(d.waterTemperature)}°` },
};
function formatForecast(forecast, settings, kind) {
  const city = cleanLabel(settings.cityLabel || '', 11);
  if (kind === 'current') {
    const d = forecast.current;
    return { icon: d.icon, title: city ? `${signed(d.temperature, 1)}°\n${city}` : `${signed(d.temperature, 1)}°\nСейчас` };
  }
  if (kind === 'metric') {
    const metric = metricFields[settings.metric] || metricFields.humidity;
    return { icon: metric.icon, title: `${metric.format(forecast.current, forecast)}\n${metric.label}` };
  }
  const today = new Date(Date.now() + (Number(forecast.location?.tzone || 0) || 0) * 60000).toISOString().slice(0,10);
  const future = forecast.daily.filter(d => d.time && d.time.slice(0, 10) >= today);
  const days = future.length ? future : forecast.daily;
  const idx = Math.min(6, Math.max(0, Math.round(Number(settings.forecastDay || 0))));
  const day = days[idx];
  if (!day) return { icon: 'unknown', title: `Нет данных\nДень ${idx + 1}` };
  const dayText = idx === 0 ? 'Сегодня' : idx === 1 ? 'Завтра' : day.time ? day.time.slice(8, 10) + '.' + day.time.slice(5, 7) : `День ${idx + 1}`;
  return { icon: day.icon, title: `${signed(day.temperature)}° / ${signed(day.lowTemperature)}°\n${dayText}` };
}
function setDisplay(ctx, view, stale = false) {
  const state = contexts.get(ctx);
  if (!state) return;
  const t = (view.title || '').slice(0, 36);
  const key = view.icon + '|' + t + '|' + stale;
  if (state.lastRender === key) return;
  state.lastRender = key;
  const img = image(view.icon);
  if (img) show(ctx, 'setImage', { image: img, target: 0 });
  show(ctx, 'setTitle', { title: stale ? '⚠ ' + t : t, target: 0 });
}
function report(ctx, status, detail = '') {
  show(ctx, 'sendToPropertyInspector', { status, detail, timestamp: Date.now() });
}
async function updateContext(ctx, force = false) {
  const state = contexts.get(ctx);
  if (!state) return;
  const generation = state.generation;
  try {
    const loc = normalizeLocation(state.settings);
    if (!loc) {
      setDisplay(ctx, { icon: 'unknown', title: 'Настройте\nгород' });
      report(ctx, 'Нужно указать город', 'Введите название города, ссылку Gismeteo, ID или координаты.');
      return;
    }
    report(ctx, 'Получаем погоду…', loc.name ? `Ищем город: ${loc.name}` : '');
    const forecast = await provider.get(loc, force);
    const current = contexts.get(ctx);
    if (!current || current.generation !== generation) return;
    setDisplay(ctx, formatForecast(forecast, current.settings, current.kind), forecast.stale);
    const locationText = loc.name ? `Поиск: ${loc.name}` : `Город Gismeteo: ${forecast.locationCode || loc.city || 'найден'}`;
    report(ctx, forecast.stale ? 'Показаны сохранённые данные' : 'Погода обновлена', forecast.error || locationText);
  } catch (e) {
    const current = contexts.get(ctx);
    if (!current || current.generation !== generation) return;
    setDisplay(ctx, { icon: 'unknown', title: 'Нет погоды\nПроверьте сеть' });
    report(ctx, 'Ошибка получения погоды', e.message);
    log(`Context ${ctx}: ${e.message}`);
  }
}
function applySettings(ctx, settings, fromInspector = false) {
  const state = contexts.get(ctx);
  if (!state) return;
  // Ignore an outdated getSettings response directly after manual refresh.
  if (!fromInspector && state.inspectorOverrideUntil > Date.now() &&
      JSON.stringify(settings || {}) !== JSON.stringify(state.settings)) return;
  state.settings = { ...(settings || {}) };
  if (fromInspector) state.inspectorOverrideUntil = Date.now() + 2500;
  state.generation++;
  state.lastRender = null;
  updateContext(ctx, fromInspector).catch(e => log(`Update error: ${e.message}`));
}
function handle(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (msg.event === 'exitApp') { closing = true; socket?.close(); return; }
  const ctx = msg.context;
  if (msg.event === 'willAppear' && ctx) {
    const kind = msg.action?.startsWith(ACTION) ? msg.action.slice(ACTION.length) : null;
    if (!['current', 'metric', 'forecast'].includes(kind)) return;
    contexts.set(ctx, { kind, settings: msg.payload?.settings || {}, generation: 0, lastRender: null, inspectorOverrideUntil: 0 });
    setDisplay(ctx, { icon: 'unknown', title: 'Загрузка…' });
    updateContext(ctx).catch(e => log(e.message));
    // Ensure host saved values are synced if appearance event omitted any fields.
    send({ event: 'getSettings', context: ctx });
  } else if (msg.event === 'willDisappear' && ctx) {
    contexts.delete(ctx);
  } else if (msg.event === 'didReceiveSettings' && ctx) {
    applySettings(ctx, msg.payload?.settings || {});
  } else if (msg.event === 'keyDown' && ctx) {
    updateContext(ctx, true).catch(e => log(e.message));
  } else if (msg.event === 'sendToPlugin' && ctx) {
    if (msg.payload?.refresh) {
      if (msg.payload.settings && typeof msg.payload.settings === 'object' && !Array.isArray(msg.payload.settings)) {
        applySettings(ctx, msg.payload.settings, true);
      } else {
        updateContext(ctx, true).catch(e => log(e.message));
      }
    }
  } else if (msg.event === 'propertyInspectorDidAppear' && ctx) {
    report(ctx, 'Плагин готов');
  }
}
function connect() {
  if (closing) return;
  const ws = new LocalWS(port);
  socket = ws;
  ws.on('open', () => { log('Connected to Stream Dock'); send({ event: args.registerEvent || 'registerPlugin', uuid }); });
  ws.on('message', handle);
  ws.on('error', e => log(`WebSocket error: ${e.message}`));
  ws.on('close', () => {
    if (closing) return;
    contexts.clear();
    setTimeout(connect, 2000).unref?.();
  });
  ws.connect();
}
if (require.main === module) {
  setInterval(() => {
    for (const ctx of contexts.keys()) updateContext(ctx).catch(e => log(e.message));
  }, 60 * 1000).unref();
  // Turn on periodic updates per provider TTL; no needless network calls.
  connect();
  process.on('SIGTERM', () => { closing = true; socket?.close(); });
}
module.exports = { formatForecast, signed, metricFields, handle, contexts, provider };
