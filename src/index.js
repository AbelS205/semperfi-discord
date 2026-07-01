require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');
const { getVendorForBrand } = require('./vendors');

const BACKEND_URL = process.env.BACKEND_URL;
// Shared secret so this bot can authenticate to the backend's protected endpoints
// (place-order, call-status) without a user login cookie. Must match INTERNAL_API_KEY
// set on the backend service. Only ever sent to BACKEND_URL — never to third parties.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const ikHeaders = { 'x-internal-key': INTERNAL_API_KEY };
// Nameplate specs (beyond brand/model) captured off the data tag, carried onto the order so the
// backend can store them and the dashboard card can show what the tech saw.
const specsFrom = (info) => ({ serial: info.serial || null, type: info.type || null, tonnage: info.tonnage || null, voltage: info.voltage || null, refrigerant: info.refrigerant || null, mfg_date: info.mfg_date || null });
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID; // optional: restrict bot to one channel
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

const app = new App({
  token: BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const pendingOrders = new Map();
const partials = new Map(); // channel-user -> { vendor, brand, model }

// ─────────────────────────────────────────────
// HVAC model number prefix → brand map
// ─────────────────────────────────────────────
const MODEL_PREFIXES = [
  { prefixes: ['24A','24AA','25H','38C','38B','38T','38G','40Q','40R','48X','48G','50X','50N','FK','FV','FE','FA','FB','FX','CH','CA','CB','CC'], brand: 'Carrier' },
  { prefixes: ['215A','225A','226A','697C','699C','697B','215C','280A','286B','286C','288B','288C','126B','127B','F1AA','F2AA'], brand: 'Bryant' },
  { prefixes: ['PA','PH','PC','PG','PF','PL','PM'], brand: 'Payne' },
  { prefixes: ['XC','XP','XR','SL','EL','ML','CL','HS','HS26','XC21','XC20','XC16','XC15','XC14','XC13','SL18','EL16','ML14','CBX','C33','G61','G71','SLP','SLO'], brand: 'Lennox' },
  { prefixes: ['AHF','AHD','AHS','ALH','APC','AXA','AWX','SCB','SGF','SGH','SSX','SHX','SSH','SCX','SWC'], brand: 'Allied' },
  { prefixes: ['CHA','CHB','CHC','CHD','CHF','CHG','CHH','CHX'], brand: 'York' },
  { prefixes: ['RA','RH','RQ','RS','RT','RP','RC','RK','RPKA','RPKB','RSPM','RSPN','RSPC','RSPA','RA13','RA14','RA15','RA16','RA17','RA18','RA20','RH1P','RH2T','RAKA','RAKB'], brand: 'Rheem' },
  { prefixes: ['UA','UH','UP','UT','UK','UM','UPKA','UPKB'], brand: 'Ruud' },
  { prefixes: ['4T','4A','2T','2A','XR','XL','XB','XC','XN','XS','XP','TWE','TEM','TUD','TUE','TUG','TUH','TUI','TUX','TCB','TAM','TDD','TDX','TXN','XR15','XR13','XL16','XL15','XL14','XL20','4TTR','4TWR','4TVR','4TXR','4TXN','TTA','TTB'], brand: 'Trane' },
  { prefixes: ['4A7','4A6','4A5','4A4','2A7','2A6','GOLD','PLAT','SILI','4AAZ','4AHP','2AAZ','2AHP','BHB','BHD','BHE','BHG','BHH','GBH','GBG','GBF','GBE','GBD','GBC','GBB','GBA','BHF'], brand: 'American Standard' },
  { prefixes: ['GSX','GSH','GSC','GPH','GPC','GME','GMH','GMV','GMC','GMS','GMVC','GMVP','GSXC','GSXN','GSXR','GPCH','GPHH','GPHM','AVPTC','ARUF','ASPT','ASUF','CAPF','CAUF','CAPG'], brand: 'Goodman' },
  { prefixes: ['ASZ','ASX','ASH','ASC','AMV','AMH','AMC','AMS','AMVC','AMVP','AVPTC','ALT','AEH','ACX','ACB','AHH','AHM','AMEC'], brand: 'Amana' },
  { prefixes: ['DX','DZ','DH','DC','DP','DV','DM','DS','DT','RZQ','RXQ','RKS','RKN','FDMQ','FTXS','FTKN'], brand: 'Daikin' },
  { prefixes: ['YC','YH','YP','YF','YK','YM','YS','YT','YU','YX','TCG','TCA','TC2','TG8','TG9','TG0','ZM','YZH','YZV','YZF'], brand: 'York' },
  { prefixes: ['TC','TM','TH','TP','CE','CH','CM','CP','CG','CGH'], brand: 'Coleman' },
  { prefixes: ['LCA','LCH','LCP','LCG','LCC','LHA','LHH','LHP','YHE','YHH','YHM','YHN'], brand: 'Luxaire' },
  { prefixes: ['BVA','BSH','BSZ','BOVA','BOXV','BCHP','BCSS','IDS'], brand: 'Bosch' },
  { prefixes: ['MHC','MCC','MPC','MPE','MHE','MCA','MPA'], brand: 'Maytag' },
];

function lookupBrandFromPrefix(modelNumber) {
  const upper = String(modelNumber).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sorted = [...MODEL_PREFIXES].sort((a, b) =>
    Math.max(...b.prefixes.map(p => p.length)) - Math.max(...a.prefixes.map(p => p.length))
  );
  for (const entry of sorted) {
    for (const prefix of entry.prefixes) {
      if (upper.startsWith(prefix.toUpperCase())) return entry.brand;
    }
  }
  return null;
}

async function lookupBrandFromModel(modelNumber) {
  const localMatch = lookupBrandFromPrefix(modelNumber);
  if (localMatch) {
    console.log(`Brand lookup: ${modelNumber} → ${localMatch} (local prefix match)`);
    return localMatch;
  }
  console.log(`Brand lookup: ${modelNumber} → not in local table, trying web search`);
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `What HVAC manufacturer makes the unit with model number "${modelNumber}"? This is a residential or light commercial HVAC unit (air conditioner, heat pump, or furnace). Search for the exact model number to identify the brand. Respond ONLY with JSON, no other text:
{
  "brand": "one of: Carrier, Bryant, Payne, Lennox, Allied, Rheem, Ruud, Trane, American Standard, Goodman, Amana, Daikin, York, Coleman, Luxaire, Bosch, JCI, AC Pro, Maytag, or Unknown",
  "confidence": "high, medium, or low",
  "reasoning": "brief explanation"
}`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });
    const textBlocks = resp.data.content.filter(b => b.type === 'text');
    if (!textBlocks.length) return null;
    const lastText = textBlocks[textBlocks.length - 1].text;
    const parsed = JSON.parse(lastText.replace(/```json|```/g,'').trim());
    console.log(`Brand lookup web result: ${modelNumber} → ${parsed.brand} (${parsed.confidence}) — ${parsed.reasoning}`);
    if (parsed.brand && parsed.brand !== 'Unknown' && parsed.confidence !== 'low') return parsed.brand;
    return null;
  } catch(err) {
    console.error('Brand lookup web error:', err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Flexible part + PO extraction from free-form text
// Accepts any PO format: "PO-2025-0442", "po 2025 0442",
// "p.o.12345", "#7788", "order 5566", or a bare number.
// ─────────────────────────────────────────────
async function extractPartPO(text) {
  if (!text || text.trim().length < 2) return { part: null, po: null, qty: 1, notes: null };
  try {
    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Extract the part and purchase order (PO) from this HVAC parts request. The PO can be written ANY way — "PO-2025-0442", "po 2025 0442", "p.o.12345", "#7788", "order 5566", "ref 99", or just a bare number. Pull out the value even if the wording is loose, and treat words like "po", "p.o.", "order", "ref", or a leading "#" as PO markers. Everything that isn't the PO or a quantity is the part. Respond ONLY with JSON, no other text:
{
  "part": "the part description, or null",
  "po": "the PO value, uppercased, keeping internal dashes (e.g. PO-2025-0442 or 12345), or null",
  "qty": 1,
  "notes": "any extra notes, or null"
}

Message: "${text.replace(/"/g, "'")}"`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });
    return JSON.parse(aiResp.data.content[0].text.replace(/```json|```/g, '').trim());
  } catch(err) {
    console.error('extractPartPO error:', err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Block Kit builders (replaces Discord embeds)
// ─────────────────────────────────────────────
function buildOrderBlocks({ vendor, brand, part, model, qty, po, notes, status, callSid, error, liveStatus }) {
  const labels = {
    pending:   '⏳ Awaiting confirmation',
    calling:   liveStatus ? `📞 Alex on the line — ${liveStatus}` : '📞 Alex is on the line...',
    placed:    '📞 Call placed',
    completed: '✅ Call completed — check dashboard',
    cancelled: '🚫 Cancelled',
    error:     '❌ Error',
  };
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Semper Fi — Parts Order' } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${labels[status] || status}*` } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Vendor:*\n${vendor.name} — ${vendor.city}\n${vendor.phone}\n${vendor.addr}` },
      { type: 'mrkdwn', text: `*Brand:*\n${brand || '—'}` },
      { type: 'mrkdwn', text: `*Part:*\n${part || '—'}` },
      { type: 'mrkdwn', text: `*Qty:*\n${qty || 1}` },
      { type: 'mrkdwn', text: `*Model:*\n${model || '—'}` },
      { type: 'mrkdwn', text: `*PO Number:*\n${po || '—'}` },
    ]},
  ];
  if (notes)   blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Notes:*\n${notes}` } });
  if (callSid) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Call SID: \`${callSid}\`` }] });
  if (error)   blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Error:* ${error}` } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Semper Fi Heating & Cooling' }] });
  return blocks;
}

function buildButtons(orderId) {
  return {
    type: 'actions',
    block_id: `order_actions_${orderId}`,
    elements: [
      { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Confirm & Call' }, action_id: `confirm_${orderId}`, value: orderId },
      { type: 'button', style: 'danger',  text: { type: 'plain_text', text: 'Cancel' },         action_id: `cancel_${orderId}`,  value: orderId },
    ],
  };
}

function orderCard(order, status, extra = {}) {
  const blocks = buildOrderBlocks({ ...order, status, ...extra });
  return { text: `Parts order — ${order.vendor?.name || ''}`, blocks };
}

// ─────────────────────────────────────────────
// Slash command: /order  → opens a modal
// ─────────────────────────────────────────────
app.command('/order', async ({ ack, command, client }) => {
  await ack();
  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'order_modal_submit',
      private_metadata: command.channel_id,
      title: { type: 'plain_text', text: 'New Parts Order' },
      submit: { type: 'plain_text', text: 'Review' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'brand', label: { type: 'plain_text', text: 'Brand' },
          element: { type: 'plain_text_input', action_id: 'v', placeholder: { type: 'plain_text', text: 'Carrier, Lennox, Trane…' } } },
        { type: 'input', block_id: 'part', label: { type: 'plain_text', text: 'Part' },
          element: { type: 'plain_text_input', action_id: 'v', placeholder: { type: 'plain_text', text: 'dual run capacitor 45/5 MFD' } } },
        { type: 'input', block_id: 'po', label: { type: 'plain_text', text: 'PO Number' },
          element: { type: 'plain_text_input', action_id: 'v', placeholder: { type: 'plain_text', text: 'PO-2025-0442' } } },
        { type: 'input', block_id: 'model', optional: true, label: { type: 'plain_text', text: 'Model #' },
          element: { type: 'plain_text_input', action_id: 'v' } },
        { type: 'input', block_id: 'qty', optional: true, label: { type: 'plain_text', text: 'Quantity' },
          element: { type: 'plain_text_input', action_id: 'v', initial_value: '1' } },
        { type: 'input', block_id: 'notes', optional: true, label: { type: 'plain_text', text: 'Notes' },
          element: { type: 'plain_text_input', action_id: 'v', multiline: true } },
      ],
    },
  });
});

app.view('order_modal_submit', async ({ ack, view, body, client }) => {
  const v = view.state.values;
  const get = (b) => (v[b]?.v?.value || '').trim();
  const brand = get('brand'), part = get('part'), po = get('po');
  const model = get('model'), notes = get('notes');
  const qty = parseInt(get('qty'), 10) || 1;
  const channel = view.private_metadata;

  const vendor = getVendorForBrand(brand);
  if (!vendor) {
    return ack({ response_action: 'errors', errors: { brand: `Unknown brand "${brand}". Try /vendors for the list.` } });
  }
  await ack();

  const order = { vendor, brand, part, model, qty, po, notes, slackUser: body.user.id };
  const orderId = `order_${body.view.id}`;
  pendingOrders.set(orderId, order);
  const card = orderCard(order, 'pending');
  await client.chat.postMessage({ channel, text: card.text, blocks: [...card.blocks, buildButtons(orderId)] });
});

// ─────────────────────────────────────────────
// Slash command: /vendors
// ─────────────────────────────────────────────
app.command('/vendors', async ({ ack, respond }) => {
  await ack();
  const lines = [
    '*Carrier / Bryant / Payne* → Russell Sigler (702) 384-2996',
    '*Lennox* → Lennox Pro Store (702) 560-6550',
    '*Allied / Rheem / Ruud* → Heating & Cooling Supply (702) 430-8652',
    '*Trane / American Standard* → Trane Supply (725) 726-2629',
    '*Goodman / Amana / Daikin* → Daikin Comfort (702) 871-1046',
    '*York / Bosch* → Johnstone Supply (702) 384-3980',
    '*Coleman / Luxaire / JCI* → Winsupply HVAC (702) 365-9722',
    '*AC Pro / Maytag* → AC Pro W Russell Rd (702) 795-4746',
  ];
  await respond({ response_type: 'ephemeral', text: lines.join('\n') });
});

// ─────────────────────────────────────────────
// Slash command: /callstatus <sid>
// ─────────────────────────────────────────────
app.command('/callstatus', async ({ ack, command, respond }) => {
  await ack();
  const sid = (command.text || '').trim();
  if (!sid) return respond({ response_type: 'ephemeral', text: 'Usage: `/callstatus <call sid>`' });
  try {
    const { data } = await axios.get(`${BACKEND_URL}/api/call-status/${sid}`, { headers: ikHeaders });
    await respond({ response_type: 'ephemeral', text: `📞 *${sid}*\nStatus: *${data.status}*${data.duration ? `\nDuration: ${data.duration}s` : ''}` });
  } catch(err) {
    await respond({ response_type: 'ephemeral', text: `❌ ${err.message}` });
  }
});

// ─────────────────────────────────────────────
// Messages — photo nameplate + natural text
// ─────────────────────────────────────────────
app.event('message', async ({ event, client }) => {
  // Ignore bots, edits, and our own messages
  if (event.bot_id || event.subtype === 'bot_message' || event.subtype === 'message_changed') return;
  if (CHANNEL_ID && event.channel !== CHANNEL_ID) return;
  if ((event.text || '').startsWith('/')) return;

  console.log('msg-event', JSON.stringify({ subtype: event.subtype||null, hasFiles: !!event.files, files: (event.files||[]).map(f=>({mime:f.mimetype, url:!!f.url_private})), text: (event.text||'').slice(0,100) }));
  let imageFile = (event.files || []).find(f => (f.mimetype || '').startsWith('image/'));
  let text = (event.text || '').trim();
  // Fallback: image shared as a Slack file link inside the message text
  if (!imageFile) {
    const m = text.match(/https:\/\/files\.slack\.com\/\S+?\.(?:jpe?g|png|gif|webp|heic)/i);
    if (m) { imageFile = { url_private: m[0], mimetype: 'image/jpeg' }; text = text.replace(m[0], '').trim(); }
  }
  if (!imageFile && !text) return;

  // ── Photo upload ──────────────────────────
  if (imageFile) {
    const thinking = await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: '📸 Reading nameplate...' });
    const edit = (msg) => client.chat.update({ channel: event.channel, ts: thinking.ts, text: typeof msg === 'string' ? msg : msg.text, blocks: msg.blocks }).catch(() => {});
    try {
      const imageResp = await axios.get(imageFile.url_private, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
      });
      const base64 = Buffer.from(imageResp.data).toString('base64');
      const mediaType = (imageFile.mimetype || 'image/jpeg').split(';')[0];

      const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `You are an expert HVAC technician reading an equipment nameplate.
Respond ONLY with this JSON, no other text:
{
  "brand": "one of: Carrier, Bryant, Payne, Lennox, Allied, Rheem, Ruud, Trane, American Standard, Goodman, Amana, Daikin, York, Bosch, Coleman, Luxaire, JCI, AC Pro, Maytag, or Unknown",
  "model": "full model number or null",
  "serial": "serial number or null",
  "type": "Air Conditioner, Heat Pump, Furnace, Air Handler, or Package Unit",
  "tonnage": "tonnage or BTU or null",
  "voltage": "voltage or null",
  "refrigerant": "refrigerant type or null",
  "mfg_date": "manufacture date or null",
  "confidence": "high, medium, or low"
}` }
          ]
        }]
      }, {
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
      });

      let info;
      try { info = JSON.parse(aiResp.data.content[0].text.replace(/```json|```/g,'').trim()); }
      catch(e) { info = { brand: 'Unknown', model: null, confidence: 'low' }; }

      let brandLookedUp = false;
      if ((info.brand === 'Unknown' || !info.brand) && info.model) {
        await edit(`📸 Nameplate read — brand not visible on tag. Looking up model *${info.model}*...`);
        const found = await lookupBrandFromModel(info.model);
        if (found) { info.brand = found; info.confidence = 'medium'; brandLookedUp = true; }
      }

      const vendor = getVendorForBrand(info.brand);
      const summary = [
        `*Brand:* ${info.brand}${brandLookedUp ? ' _(identified from model number)_' : ''}`,
        info.model ? `*Model:* ${info.model}` : null,
        info.serial ? `*Serial:* ${info.serial}` : null,
        info.type ? `*Type:* ${info.type}` : null,
        info.tonnage ? `*Tonnage:* ${info.tonnage}` : null,
        info.voltage ? `*Voltage:* ${info.voltage}` : null,
        info.refrigerant ? `*Refrigerant:* ${info.refrigerant}` : null,
        info.mfg_date ? `*Mfg Date:* ${info.mfg_date}` : null,
        `*Confidence:* ${info.confidence}`,
        vendor ? `\n✅ Auto-selected vendor: *${vendor.name}* (${vendor.city})`
               : `\n❓ Brand not in vendor map — please use \`/order\` to specify manually`,
      ].filter(Boolean).join('\n');

      if (!vendor || info.brand === 'Unknown') {
        await edit(`🔍 Nameplate read:\n${summary}\n\n❓ Could not identify brand${info.model ? ` from model *${info.model}*` : ''}. Please use \`/order\` and specify brand manually.`);
        return;
      }

      const extracted = (text && text.trim().length > 2) ? await extractPartPO(text) : null;

      if (extracted && extracted.po && extracted.part) {
        const order = { vendor, brand: info.brand, part: extracted.part, model: info.model || '', qty: extracted.qty || 1, po: String(extracted.po).toUpperCase(), notes: extracted.notes || '', slackUser: event.user, specs: specsFrom(info) };
        const orderId = `photo_${event.ts}`;
        pendingOrders.set(orderId, order);
        const card = orderCard(order, 'pending');
        await edit({ text: `🔍 Nameplate read:\n${summary}`, blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `🔍 *Nameplate read:*\n${summary}` } },
          ...card.blocks, buildButtons(orderId),
        ]});
      } else {
        partials.set(`${event.channel}-${event.user}`, { vendor, brand: info.brand, model: info.model || '', specs: specsFrom(info), photoTs: event.ts });
        await edit(`🔍 Nameplate read:\n${summary}\n\nNow send me the *part* and a *PO number* — any format is fine, e.g. \`45/5 MFD capacitor, PO 2025-0442\` or \`contactor #7788\`.`);
      }
    } catch(err) {
      console.error('Photo error:', err.response?.data || err.message);
      await edit('❌ Error reading nameplate. Please try again or use `/order`.');
    }
    return;
  }

  // ── Follow-up to a photo scan ─────────────
  const partialKey = `${event.channel}-${event.user}`;
  const partial = partials.get(partialKey);
  if (partial) {
    const extracted = await extractPartPO(text);
    const po = extracted?.po ? String(extracted.po).toUpperCase() : null;
    const part = extracted?.part || null;
    if (!po || !part) {
      await client.chat.postMessage({ channel: event.channel, text: 'I just need a *part* and a *PO number* — any format works, e.g. `45/5 MFD capacitor PO 2025-0442` or `contactor #7788`.' });
      return;
    }
    partials.delete(partialKey);
    const order = { vendor: partial.vendor, brand: partial.brand, part, model: partial.model, qty: extracted.qty || 1, po, notes: extracted.notes || '', slackUser: event.user, specs: partial.specs };
    const orderId = `partial_${event.ts}`;
    pendingOrders.set(orderId, order);
    const card = orderCard(order, 'pending');
    await client.chat.postMessage({ channel: event.channel, thread_ts: partial.photoTs, text: card.text, blocks: [...card.blocks, buildButtons(orderId)] });
    return;
  }

  // ── Fresh natural-language order ───────────
  const thinking = await client.chat.postMessage({ channel: event.channel, text: '🤔 Parsing order...' });
  const edit = (msg) => client.chat.update({ channel: event.channel, ts: thinking.ts, text: typeof msg === 'string' ? msg : msg.text, blocks: msg.blocks }).catch(() => {});
  try {
    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are an HVAC parts ordering assistant for Semper Fi Heating and Cooling in Las Vegas.
Parse this message and respond ONLY with JSON, no other text:

"${text}"

{
  "brand": "one of: Carrier, Bryant, Payne, Lennox, Allied, Rheem, Ruud, Trane, American Standard, Goodman, Amana, Daikin, York, Bosch, Coleman, Luxaire, JCI, AC Pro, Maytag, or null if unclear",
  "part": "part description or null",
  "model": "model number or null",
  "qty": 1,
  "po": "PO/order number in ANY format (PO-2025-0442, 'po 2025 0442', '#7788', 'order 5566', or a bare number), or null",
  "notes": "any extra notes or null",
  "missing": ["list missing required fields from: brand, part, po"]
}`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    let parsed;
    try { parsed = JSON.parse(aiResp.data.content[0].text.replace(/```json|```/g,'').trim()); }
    catch(e) { return edit('❌ Could not parse that. Try:\n`Carrier capacitor 45/5 MFD PO-2025-0442`'); }

    if ((!parsed.brand || parsed.brand === 'null') && parsed.model) {
      await edit(`🤔 Brand not mentioned — looking up model *${parsed.model}*...`);
      const found = await lookupBrandFromModel(parsed.model);
      if (found) { parsed.brand = found; parsed.missing = (parsed.missing || []).filter(f => f !== 'brand'); }
    }

    if (parsed.missing?.length > 0) {
      return edit(`⚠️ Missing: *${parsed.missing.join(', ')}*\n\nExample:\n\`Carrier dual run capacitor 45/5 MFD qty 2 PO-2025-0442 unit is down\``);
    }

    const vendor = getVendorForBrand(parsed.brand);
    if (!vendor) {
      return edit(`❓ Brand *${parsed.brand}* not found. Use \`/vendors\` to see the list.`);
    }

    const order = { vendor, brand: parsed.brand, part: parsed.part, model: parsed.model || '', qty: parsed.qty || 1, po: parsed.po, notes: parsed.notes || '', slackUser: event.user };
    const orderId = `nlp_${event.ts}`;
    pendingOrders.set(orderId, order);
    const card = orderCard(order, 'pending');
    await edit({ text: card.text, blocks: [...card.blocks, buildButtons(orderId)] });
  } catch(err) {
    console.error('NLP error:', err.response?.data || err.message);
    await edit('❌ Something went wrong. Try `/order` instead.');
  }
});

// ─────────────────────────────────────────────
// Buttons — Confirm & Call / Cancel
// ─────────────────────────────────────────────
app.action(/^cancel_/, async ({ ack, body, action, client }) => {
  await ack();
  const orderId = action.value;
  const order = pendingOrders.get(orderId);
  if (!order) return;
  pendingOrders.delete(orderId);
  const card = orderCard(order, 'cancelled');
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: card.text, blocks: card.blocks });
});

app.action(/^confirm_/, async ({ ack, body, action, client }) => {
  await ack();
  const orderId = action.value;
  const order = pendingOrders.get(orderId);
  if (!order) return;
  pendingOrders.delete(orderId);

  const channel = body.channel.id;
  const ts = body.message.ts;
  let card = orderCard(order, 'calling');
  await client.chat.update({ channel, ts, text: card.text, blocks: card.blocks }).catch(() => {});

  try {
    const { data } = await axios.post(`${BACKEND_URL}/api/place-order`, {
      vendorName: order.vendor.name,
      vendorPhone: order.vendor.phone,
      vendorCity: order.vendor.city,
      vendorAddr: order.vendor.addr,
      brand: order.brand,
      model: order.model,
      part: order.part,
      qty: String(order.qty),
      po: order.po,
      notes: order.notes,
      discordUser: order.slackUser,   // backend column name; carries the Slack user id
      discordUserId: order.slackUser,
      specs: order.specs || null,     // nameplate details for the dashboard card
    }, { headers: ikHeaders });
    card = orderCard(order, 'placed', { callSid: data.callSid });
    await client.chat.update({ channel, ts, text: card.text, blocks: card.blocks }).catch(() => {});
    pollCallStatus(data.callSid, client, channel, ts, order);
  } catch(err) {
    card = orderCard(order, 'error', { error: err.response?.data?.error || err.message });
    await client.chat.update({ channel, ts, text: card.text, blocks: card.blocks }).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// Poll call status — updates the card + posts outcome
// ─────────────────────────────────────────────
function pollCallStatus(callSid, client, channel, ts, order) {
  let polls = 0;
  const MAX_POLLS = 120;       // 10 minutes at 5s
  const POLL_INTERVAL = 5000;
  const TERMINAL = ['ended'];

  const interval = setInterval(async () => {
    polls++;
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/call-status/${callSid}`, { headers: ikHeaders });
      const status = data.status;

      if (!TERMINAL.includes(status) && polls % 3 === 0) {
        const card = orderCard(order, 'calling', { callSid, liveStatus: status });
        await client.chat.update({ channel, ts, text: card.text, blocks: card.blocks }).catch(() => {});
      }

      if (TERMINAL.includes(status) || polls >= MAX_POLLS) {
        clearInterval(interval);
        const timedOut = polls >= MAX_POLLS && !TERMINAL.includes(status);
        const endReason = data.endedReason || '';
        const success = status === 'ended' && !endReason.includes('error') && endReason !== 'voicemail' && endReason !== 'no-answer' && endReason !== 'customer-did-not-answer';

        let eta = null, summary = null;
        if (status === 'ended') {
          try {
            await new Promise(r => setTimeout(r, 4000));
            const { data: callData } = await axios.get(`${BACKEND_URL}/api/call-status/${callSid}`, { headers: ikHeaders });
            eta = callData.eta || null;
            summary = callData.summary || null;
          } catch(e) {}
        }

        const card = orderCard(order, success ? 'completed' : 'error', {
          callSid,
          error: timedOut ? 'Call timed out — check dashboard' : (!success ? `Ended: ${endReason || status}` : null),
        });
        await client.chat.update({ channel, ts, text: card.text, blocks: card.blocks }).catch(() => {});

        let outcomeMsg = '';
        if (timedOut) {
          outcomeMsg = `⏱️ *Still tracking* — Alex may still be on the line with *${order.vendor.name}*. Check your dashboard.`;
        } else if (endReason === 'voicemail') {
          outcomeMsg = `📬 *Went to voicemail* — *${order.vendor.name}* didn't answer. Try calling back later.`;
        } else if (endReason === 'customer-did-not-answer' || endReason === 'no-answer') {
          outcomeMsg = `📭 *No answer* — *${order.vendor.name}* didn't pick up. Try again shortly.`;
        } else if (endReason?.includes('error')) {
          outcomeMsg = `❌ *Call error* — ${endReason}. Check your Vapi dashboard.`;
        } else if (success) {
          outcomeMsg = `✅ *Call completed* — Alex finished the call with *${order.vendor.name}* for PO \`${order.po}\`.`;
          if (eta) outcomeMsg += `\n📦 *ETA: ${eta}*`;
          if (summary) outcomeMsg += `\n📋 *Summary:* ${summary}`;
          if (!eta && !summary) outcomeMsg += `\nCheck your dashboard for details.`;
        } else {
          outcomeMsg = `⚠️ Call ended — ${endReason || 'unknown reason'}.`;
        }
        await client.chat.postMessage({ channel, thread_ts: ts, text: outcomeMsg }).catch(() => {});
      }
    } catch(err) {
      console.error(`Poll error (${polls}/${MAX_POLLS}):`, err.message);
      if (polls >= MAX_POLLS) {
        clearInterval(interval);
        await client.chat.postMessage({ channel, thread_ts: ts, text: `⏱️ Lost track of the call to *${order.vendor.name}*. Check your dashboard.` }).catch(() => {});
      }
    }
  }, POLL_INTERVAL);
}

// ─────────────────────────────────────────────
// Tiny health server so the Agent Hub can see the bot's status.
// (Railway: generate a public domain for this service.)
// ─────────────────────────────────────────────
require('http').createServer((req, res) => {
  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status: 'ok', service: 'Slack Intake Bot', engine: 'Bolt \u00b7 Socket Mode' }));
  } else { res.writeHead(404); res.end(); }
}).listen(process.env.PORT || 3000, () => console.log('Health server listening on', process.env.PORT || 3000));

// ─────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('Semper Fi Slack intake bot online (Socket Mode)');
})();
