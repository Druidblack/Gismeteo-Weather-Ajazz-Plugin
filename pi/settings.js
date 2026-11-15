'use strict';
// Property Inspector: the current form snapshot is always sent with a manual
// refresh, because Stream Dock can acknowledge setSettings asynchronously.
let ws = null;
let context = '';
let settings = {};
let ready = false;
let savingTimer = null;
let modified = false;
const fields = ['cityLabel', 'cityId', 'latitude', 'longitude', 'metric', 'forecastDay'];
const $ = id => document.getElementById(id);
function send(event, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, context, payload }));
    return true;
  }
  return false;
}
function snapshot() {
  const result = { ...settings };
  for (const id of fields) result[id] = $(id).value;
  return result;
}
function populate() {
  for (const id of fields) {
    if (document.activeElement === $(id)) continue;
    $(id).value = settings[id] == null ? '' : String(settings[id]);
  }
}
function save() {
  if (!ready) return;
  settings = snapshot();
  modified = true;
  send('setSettings', settings);
}
function queueSave() {
  modified = true;
  clearTimeout(savingTimer);
  savingTimer = setTimeout(() => { savingTimer = null; save(); }, 350);
}
for (const id of fields) {
  $(id).addEventListener('input', queueSave);
  $(id).addEventListener('change', () => {
    modified = true;
    clearTimeout(savingTimer);
    savingTimer = null;
    save();
  });
}
$('refresh').addEventListener('click', () => {
  if (!ready) { $('state').textContent = 'Нет подключения к Stream Dock'; return; }
  clearTimeout(savingTimer);
  savingTimer = null;
  save(); // persist first
  // Send the actual fields too: don't wait for the host's settings round trip.
  send('sendToPlugin', { refresh: true, settings: snapshot() });
  $('state').textContent = 'Запрашиваем обновление погоды…';
  $('detail').textContent = '';
});
function readInfo(info) {
  try { return typeof info === 'string' ? JSON.parse(info) : info || {}; }
  catch (_) { return {}; }
}
function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  const actionInfo = readInfo(inActionInfo);
  context = actionInfo.context || '';
  const action = actionInfo.action || '';
  $('metricSection').classList.toggle('hidden', !action.endsWith('.metric'));
  $('forecastSection').classList.toggle('hidden', !action.endsWith('.forecast'));
  settings = { ...(actionInfo.payload?.settings || actionInfo.settings || {}) };
  populate();
  ws = new WebSocket('ws://127.0.0.1:' + inPort);
  ws.onopen = () => {
    ready = true;
    ws.send(JSON.stringify({ event: inRegisterEvent || 'registerPropertyInspector', uuid: inUUID }));
    send('getSettings', {});
  };
  ws.onclose = () => { ready = false; $('state').textContent = 'Соединение с Stream Dock потеряно'; };
  ws.onerror = () => { $('state').textContent = 'Ошибка подключения к Stream Dock'; };
  ws.onmessage = message => {
    let data;
    try { data = JSON.parse(message.data); } catch (_) { return; }
    if (data.event === 'didReceiveSettings' && (!data.context || data.context === context)) {
      // Never discard edits if the host answers an older getSettings request.
      if (!modified) {
        settings = { ...(data.payload?.settings || {}) };
        populate();
      }
    }
    if (data.event === 'sendToPropertyInspector' && (!data.context || data.context === context)) {
      $('state').textContent = data.payload?.status || 'Готово';
      $('detail').textContent = data.payload?.detail || '';
    }
  };
}
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
