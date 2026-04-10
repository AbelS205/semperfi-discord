require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const { getVendorForBrand } = require('./vendors');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const BACKEND_URL       = process.env.BACKEND_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHANNEL_ID        = process.env.DISCORD_CHANNEL_ID;

const pendingOrders = new Map();

// ─────────────────────────────────────────────
// Ready
// ─────────────────────────────────────────────
client.once('ready', () => {
  console.log(`Semper Fi bot online as ${client.user.tag}`);
});

// ─────────────────────────────────────────────
// Brand lookup from model number
// Called when nameplate vision returns Unknown brand
// but a model number was found
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// HVAC model number prefix → brand map
// Covers the most common residential/light commercial units
// ─────────────────────────────────────────────
const MODEL_PREFIXES = [
  // Carrier family
  { prefixes: ['24A','24AA','25H','38C','38B','38T','38G','40Q','40R','48X','48G','50X','50N','FK','FV','FE','FA','FB','FX','CH','CA','CB','CC'], brand: 'Carrier' },
  // Bryant family
  { prefixes: ['215A','225A','226A','697C','699C','697B','215C','280A','286B','286C','288B','288C','126B','127B','F1AA','F2AA'], brand: 'Bryant' },
  // Payne
  { prefixes: ['PA','PH','PC','PG','PF','PL','PM'], brand: 'Payne' },
  // Lennox family
  { prefixes: ['XC','XP','XR','SL','EL','ML','CL','HS','HS26','XC21','XC20','XC16','XC15','XC14','XC13','SL18','EL16','ML14','CBX','C33','G61','G71','SLP','SLO'], brand: 'Lennox' },
  // Allied (Lennox brand)
  { prefixes: ['AHF','AHD','AHS','ALH','APC','AXA','AWX','SCB','SGF','SGH','SSX','SHX','SSH','SCX','SWC'], brand: 'Allied' },
  // Champion (York/JCI brand)
  { prefixes: ['CHA','CHB','CHC','CHD','CHF','CHG','CHH','CHX'], brand: 'York' },
  // Rheem/Ruud family
  { prefixes: ['RA','RH','RQ','RS','RT','RP','RC','RK','RPKA','RPKB','RSPM','RSPN','RSPC','RSPA','RA13','RA14','RA15','RA16','RA17','RA18','RA20','RH1P','RH2T','RAKA','RAKB'], brand: 'Rheem' },
  { prefixes: ['UA','UH','UP','UT','UK','UM','UPKA','UPKB'], brand: 'Ruud' },
  // Trane/American Standard family
  { prefixes: ['4T','4A','2T','2A','XR','XL','XB','XC','XN','XS','XP','TWE','TEM','TUD','TUE','TUG','TUH','TUI','TUX','TCB','TAM','TDD','TDX','TXN','XR15','XR13','XL16','XL15','XL14','XL20','4TTR','4TWR','4TVR','4TXR','4TXN','TTA','TTB'], brand: 'Trane' },
  { prefixes: ['4A7','4A6','4A5','4A4','2A7','2A6','GOLD','PLAT','SILI','4AAZ','4AHP','2AAZ','2AHP','BHB','BHD','BHE','BHG','BHH','GBH','GBG','GBF','GBE','GBD','GBC','GBB','GBA','BHF'], brand: 'American Standard' },
  // Goodman/Amana/Daikin family
  { prefixes: ['GSX','GSH','GSC','GPH','GPC','GME','GMH','GMV','GMC','GMS','GMVC','GMVP','GSXC','GSXN','GSXR','GPCH','GPHH','GPHM','AVPTC','ARUF','ASPT','ASUF','CAPF','CAUF','CAPG'], brand: 'Goodman' },
  { prefixes: ['ASZ','ASX','ASH','ASC','AMV','AMH','AMC','AMS','AMVC','AMVP','AVPTC','ALT','AEH','ACX','ACB','AHH','AHM','AMEC'], brand: 'Amana' },
  { prefixes: ['DX','DZ','DH','DC','DP','DV','DM','DS','DT','RZQ','RXQ','RKS','RKN','FDMQ','FTXS','FTKN'], brand: 'Daikin' },
  // York/Coleman/Luxaire/JCI family
  { prefixes: ['YC','YH','YP','YF','YK','YM','YS','YT','YU','YX','TCG','TCA','TC2','TG8','TG9','TG0','ZM','YZH','YZV','YZF'], brand: 'York' },
  { prefixes: ['TC','TM','TH','TP','CE','CH','CM','CP','CG','CGH'], brand: 'Coleman' },
  { prefixes: ['LCA','LCH','LCP','LCG','LCC','LHA','LHH','LHP','YHE','YHH','YHM','YHN'], brand: 'Luxaire' },
  // Bosch
  { prefixes: ['BVA','BSH','BSZ','BOVA','BOXV','BCHP','BCSS','IDS'], brand: 'Bosch' },
  // AC Pro / Maytag
  { prefixes: ['MHC','MCC','MPC','MPE','MHE','MCA','MPA'], brand: 'Maytag' },
];

function lookupBrandFromPrefix(modelNumber) {
  const upper = String(modelNumber).toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Sort by prefix length descending so longer prefixes match first
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
  // Step 1: Try local prefix table first — fast and accurate
  const localMatch = lookupBrandFromPrefix(modelNumber);
  if (localMatch) {
    console.log(`Brand lookup: ${modelNumber} → ${localMatch} (local prefix match)`);
    return localMatch;
  }

  // Step 2: Fall back to Claude web search for unknown models
  console.log(`Brand lookup: ${modelNumber} → not in local table, trying web search`);
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
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

    // Get last text block (after any tool_use blocks)
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
// Slash commands
// ─────────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // /order
  if (interaction.isChatInputCommand() && interaction.commandName === 'order') {
    const brand = interaction.options.getString('brand');
    const part  = interaction.options.getString('part');
    const po    = interaction.options.getString('po');
    const model = interaction.options.getString('model') || '';
    const qty   = interaction.options.getInteger('qty') || 1;
    const notes = interaction.options.getString('notes') || '';

    const vendor = getVendorForBrand(brand);
    if (!vendor) {
      return interaction.reply({ content: `❌ Unknown brand **${brand}**. Use \`/vendors\` to see supported brands.`, ephemeral: true });
    }

    const orderId = `${interaction.id}`;
    const order = { vendor, brand, part, model, qty, po, notes, discordUser: interaction.user.username, discordUserId: interaction.user.id };
    pendingOrders.set(orderId, order);

    await interaction.reply({ embeds: [buildOrderEmbed({ ...order, status: 'pending' })], components: [buildButtons(orderId)] });
  }

  // /vendors
  if (interaction.isChatInputCommand() && interaction.commandName === 'vendors') {
    const lines = [
      '**Carrier / Bryant / Payne** → Russell Sigler (702) 384-2996',
      '**Lennox** → Lennox Pro Store (702) 560-6550',
      '**Allied / Rheem / Ruud** → Heating & Cooling Supply (702) 430-8652',
      '**Trane / American Standard** → Trane Supply (725) 726-2629',
      '**Goodman / Amana / Daikin** → Daikin Comfort (702) 871-1046',
      '**York / Bosch** → Johnstone Supply (702) 384-3980',
      '**Coleman / Luxaire / JCI** → Winsupply HVAC (702) 365-9722',
      '**AC Pro / Maytag** → AC Pro W Russell Rd (702) 795-4746',
    ];
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }

  // /callstatus
  if (interaction.isChatInputCommand() && interaction.commandName === 'callstatus') {
    const sid = interaction.options.getString('sid');
    await interaction.deferReply({ ephemeral: true });
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/call-status/${sid}`);
      return interaction.editReply(`📞 **${sid}**\nStatus: **${data.status}**${data.duration ? `\nDuration: ${data.duration}s` : ''}`);
    } catch(err) {
      return interaction.editReply(`❌ ${err.message}`);
    }
  }

  // Buttons — confirm / cancel
  if (interaction.isButton()) {
    const parts   = interaction.customId.split('_');
    const action  = parts[0];
    const orderId = parts.slice(1).join('_');
    const order   = pendingOrders.get(orderId);
    if (!order) return interaction.reply({ content: '❌ Order not found or already processed.', ephemeral: true });

    if (action === 'cancel') {
      pendingOrders.delete(orderId);
      return interaction.update({ embeds: [buildOrderEmbed({ ...order, status: 'cancelled' })], components: [] });
    }

    if (action === 'confirm') {
      pendingOrders.delete(orderId);
      await interaction.deferUpdate();
      await interaction.editReply({ embeds: [buildOrderEmbed({ ...order, status: 'calling' })], components: [] });

      try {
        const { data } = await axios.post(`${BACKEND_URL}/api/place-order`, {
          vendorName:    order.vendor.name,
          vendorPhone:   order.vendor.phone,
          vendorCity:    order.vendor.city,
          vendorAddr:    order.vendor.addr,
          brand:         order.brand,
          model:         order.model,
          part:          order.part,
          qty:           String(order.qty),
          po:            order.po,
          notes:         order.notes,
          discordUser:   order.discordUser,
          discordUserId: order.discordUserId,
        });

        await interaction.editReply({ embeds: [buildOrderEmbed({ ...order, status: 'placed', callSid: data.callSid })], components: [] });
        pollCallStatus(data.callSid, interaction, order);

      } catch(err) {
        await interaction.editReply({ embeds: [buildOrderEmbed({ ...order, status: 'error', error: err.response?.data?.error || err.message })], components: [] });
      }
    }
  }
});

// ─────────────────────────────────────────────
// Messages — photo + natural text
// ─────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (CHANNEL_ID && message.channelId !== CHANNEL_ID) return;
  if (message.content.startsWith('/')) return;

  const hasPhoto = message.attachments.some(a => a.contentType?.startsWith('image/'));
  const hasText  = message.content.trim().length > 0;
  if (!hasPhoto && !hasText) return;

  // ── Photo upload ──────────────────────────
  if (hasPhoto) {
    const attachment = message.attachments.find(a => a.contentType?.startsWith('image/'));
    const thinking   = await message.reply('📸 Reading nameplate...');

    try {
      const imageResp = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      const base64    = Buffer.from(imageResp.data).toString('base64');
      const mediaType = attachment.contentType.split(';')[0];

      // Step 1 — read nameplate with vision
      const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text',  text: `You are an expert HVAC technician reading an equipment nameplate.
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

      // Step 2 — if brand is Unknown but model found, look it up
      let brandLookedUp = false;
      if ((info.brand === 'Unknown' || !info.brand) && info.model) {
        await thinking.edit(`📸 Nameplate read — brand not visible on tag. Looking up model **${info.model}**...`);
        const found = await lookupBrandFromModel(info.model);
        if (found) {
          info.brand     = found;
          info.confidence = 'medium';
          brandLookedUp  = true;
        }
      }

      const vendor = getVendorForBrand(info.brand);

      const summary = [
        `**Brand:** ${info.brand}${brandLookedUp ? ' *(identified from model number)*' : ''}`,
        info.model       ? `**Model:** ${info.model}`             : null,
        info.serial      ? `**Serial:** ${info.serial}`           : null,
        info.type        ? `**Type:** ${info.type}`               : null,
        info.tonnage     ? `**Tonnage:** ${info.tonnage}`         : null,
        info.voltage     ? `**Voltage:** ${info.voltage}`         : null,
        info.refrigerant ? `**Refrigerant:** ${info.refrigerant}` : null,
        info.mfg_date    ? `**Mfg Date:** ${info.mfg_date}`       : null,
        `**Confidence:** ${info.confidence}`,
        vendor
          ? `\n✅ Auto-selected vendor: **${vendor.name}** (${vendor.city})`
          : `\n❓ Brand not in vendor map — please use \`/order\` to specify manually`,
      ].filter(Boolean).join('\n');

      if (!vendor || info.brand === 'Unknown') {
        await thinking.edit(`🔍 Nameplate read:\n${summary}\n\n❓ Could not identify brand${info.model ? ` from model **${info.model}**` : ''}. Please use \`/order\` and specify brand manually.`);
        return;
      }

      // Check if message text also has part + PO
      const poMatch   = message.content.match(/PO[-\s]?\w+/i);
      const po        = poMatch ? poMatch[0].replace(/\s/g,'').toUpperCase() : null;
      const textClean = message.content.replace(/PO[-\s]?\w+/i,'').replace(/[|,]/g,'').trim();

      if (po && textClean.length > 3) {
        const order   = { vendor, brand: info.brand, part: textClean, model: info.model || '', qty: 1, po, notes: '', discordUser: message.author.username, discordUserId: message.author.id };
        const orderId = `photo_${message.id}`;
        pendingOrders.set(orderId, order);
        await thinking.edit({ content: `🔍 Nameplate read:\n${summary}`, embeds: [buildOrderEmbed({ ...order, status: 'pending' })], components: [buildButtons(orderId)] });
      } else {
        client._partials = client._partials || new Map();
        client._partials.set(`${message.channelId}-${message.author.id}`, { vendor, brand: info.brand, model: info.model || '' });
        await thinking.edit(`🔍 Nameplate read:\n${summary}\n\nNow tell me the **part needed** and **PO number**, e.g.:\n\`capacitor 45/5 MFD | PO-2025-0442\``);
      }

    } catch(err) {
      console.error('Photo error:', err.response?.data || err.message);
      await thinking.edit('❌ Error reading nameplate. Please try again or use `/order`.');
    }
    return;
  }

  // ── Follow-up to photo scan ───────────────
  const partialKey = `${message.channelId}-${message.author.id}`;
  const partial    = client._partials?.get(partialKey);

  if (partial) {
    const text    = message.content.trim();
    const poMatch = text.match(/PO[-\s]?\w+/i);
    const po      = poMatch ? poMatch[0].replace(/\s/g,'').toUpperCase() : null;
    const part    = text.replace(/PO[-\s]?\w+/i,'').replace(/[|,]/g,'').trim();

    if (!po || !part) {
      return message.reply('Please include both the part and PO, e.g. `capacitor 45/5 MFD | PO-2025-0442`');
    }

    client._partials.delete(partialKey);
    const order   = { vendor: partial.vendor, brand: partial.brand, part, model: partial.model, qty: 1, po, notes: '', discordUser: message.author.username, discordUserId: message.author.id };
    const orderId = `partial_${message.id}`;
    pendingOrders.set(orderId, order);
    await message.reply({ embeds: [buildOrderEmbed({ ...order, status: 'pending' })], components: [buildButtons(orderId)] });
    return;
  }

  // ── Fresh natural text ────────────────────
  const thinking = await message.reply('🤔 Parsing order...');

  try {
    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are an HVAC parts ordering assistant for Semper Fi Heating and Cooling in Las Vegas.
Parse this message and respond ONLY with JSON, no other text:

"${message.content}"

{
  "brand": "one of: Carrier, Bryant, Payne, Lennox, Allied, Rheem, Ruud, Trane, American Standard, Goodman, Amana, Daikin, York, Bosch, Coleman, Luxaire, JCI, AC Pro, Maytag, or null if unclear",
  "part": "part description or null",
  "model": "model number or null",
  "qty": 1,
  "po": "PO number or null",
  "notes": "any extra notes or null",
  "missing": ["list missing required fields from: brand, part, po"]
}`
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    let parsed;
    try { parsed = JSON.parse(aiResp.data.content[0].text.replace(/```json|```/g,'').trim()); }
    catch(e) { return thinking.edit('❌ Could not parse that. Try:\n`Carrier capacitor 45/5 MFD PO-2025-0442`'); }

    // If brand missing but model present, try to look it up
    if ((!parsed.brand || parsed.brand === 'null') && parsed.model) {
      await thinking.edit(`🤔 Brand not mentioned — looking up model **${parsed.model}**...`);
      const found = await lookupBrandFromModel(parsed.model);
      if (found) {
        parsed.brand = found;
        parsed.missing = (parsed.missing || []).filter(f => f !== 'brand');
      }
    }

    if (parsed.missing?.length > 0) {
      return thinking.edit(`⚠️ Missing: **${parsed.missing.join(', ')}**\n\nExample:\n\`Carrier dual run capacitor 45/5 MFD qty 2 PO-2025-0442 unit is down\``);
    }

    const vendor = getVendorForBrand(parsed.brand);
    if (!vendor) {
      return thinking.edit(`❓ Brand **${parsed.brand}** not found. Use \`/vendors\` to see the list.`);
    }

    const order   = { vendor, brand: parsed.brand, part: parsed.part, model: parsed.model || '', qty: parsed.qty || 1, po: parsed.po, notes: parsed.notes || '', discordUser: message.author.username, discordUserId: message.author.id };
    const orderId = `nlp_${message.id}`;
    pendingOrders.set(orderId, order);
    await thinking.edit({ content: '', embeds: [buildOrderEmbed({ ...order, status: 'pending' })], components: [buildButtons(orderId)] });

  } catch(err) {
    console.error('NLP error:', err.response?.data || err.message);
    await thinking.edit('❌ Something went wrong. Try `/order` instead.');
  }
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function buildButtons(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_${orderId}`).setLabel('Confirm & Call').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancel_${orderId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
  );
}

function buildOrderEmbed({ vendor, brand, part, model, qty, po, notes, status, callSid, error, liveStatus }) {
  const colors = { pending:0x378ADD, calling:0xEF9F27, placed:0x1D9E75, completed:0x1D9E75, cancelled:0x888780, error:0xE24B4A };
  const labels = { pending:'⏳ Awaiting confirmation', calling: liveStatus ? `📞 Alex on the line — ${liveStatus}` : '📞 Alex is on the line...', placed:'📞 Call placed', completed:'✅ Call completed — check dashboard', cancelled:'🚫 Cancelled', error:'❌ Error' };

  const embed = new EmbedBuilder()
    .setColor(colors[status] || 0x378ADD)
    .setTitle('Semper Fi — Parts Order')
    .setDescription(labels[status] || status)
    .addFields(
      { name: 'Vendor',    value: `${vendor.name} — ${vendor.city}\n${vendor.phone}\n${vendor.addr}`, inline: true },
      { name: 'Brand',     value: brand || '—',        inline: true },
      { name: '\u200b',    value: '\u200b',             inline: true },
      { name: 'Part',      value: part  || '—',        inline: true },
      { name: 'Qty',       value: String(qty || 1),     inline: true },
      { name: 'Model',     value: model || '—',        inline: true },
      { name: 'PO Number', value: po    || '—',        inline: true },
    )
    .setFooter({ text: 'Semper Fi Heating & Cooling' })
    .setTimestamp();

  if (notes)   embed.addFields({ name: 'Notes',    value: notes });
  if (callSid) embed.addFields({ name: 'Call SID', value: `\`${callSid}\`` });
  if (error)   embed.addFields({ name: 'Error',    value: error });
  return embed;
}

async function pollCallStatus(callSid, interaction, order) {
  let polls = 0;
  const MAX_POLLS     = 120;  // 10 minutes at 5s intervals
  const POLL_INTERVAL = 5000;

  // Vapi status values: queued, ringing, in-progress, forwarding, ended
  const TERMINAL = ['ended'];

  const interval = setInterval(async () => {
    polls++;
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/call-status/${callSid}`);
      const status = data.status;

      // Update embed every 15 seconds while call is live
      if (!TERMINAL.includes(status) && polls % 3 === 0) {
        await interaction.editReply({
          embeds: [buildOrderEmbed({ ...order, status:'calling', callSid, liveStatus: status })],
          components: [],
        }).catch(() => {});
      }

      if (TERMINAL.includes(status) || polls >= MAX_POLLS) {
        clearInterval(interval);

        const timedOut  = polls >= MAX_POLLS && !TERMINAL.includes(status);
        const endReason = data.endedReason || '';
        const success   = status === 'ended' && !endReason.includes('error') && endReason !== 'voicemail' && endReason !== 'no-answer' && endReason !== 'customer-did-not-answer';

        // Try to get ETA from Vapi call analysis (runs a few seconds after call ends)
        let eta = null;
        let summary = null;
        if (status === 'ended') {
          try {
            await new Promise(r => setTimeout(r, 4000)); // wait for analysis
            const { data: callData } = await axios.get(`${BACKEND_URL}/api/call-status/${callSid}`);
            eta     = callData.eta     || null;
            summary = callData.summary || null;
          } catch(e) {}
        }

        // Final embed
        await interaction.editReply({
          embeds: [buildOrderEmbed({ ...order, status: success ? 'completed' : 'error', callSid,
            error: timedOut ? 'Call timed out — check dashboard' : (!success ? `Ended: ${endReason || status}` : null),
          })],
          components: [],
        }).catch(() => {});

        // Outcome message with ETA if available
        let outcomeMsg = '';
        if (timedOut) {
          outcomeMsg = `⏱️ **Still tracking** — Alex may still be on the line with **${order.vendor.name}**. Check your dashboard.`;
        } else if (endReason === 'voicemail') {
          outcomeMsg = `📬 **Went to voicemail** — **${order.vendor.name}** didn't answer. Try calling back later.`;
        } else if (endReason === 'customer-did-not-answer' || endReason === 'no-answer') {
          outcomeMsg = `📭 **No answer** — **${order.vendor.name}** didn't pick up. Try again shortly.`;
        } else if (endReason?.includes('error')) {
          outcomeMsg = `❌ **Call error** — ${endReason}. Check your Vapi dashboard.`;
        } else if (success) {
          outcomeMsg = `✅ **Call completed** — Alex finished the call with **${order.vendor.name}** for PO \`${order.po}\`.`;
          if (eta)     outcomeMsg += `\n📦 **ETA: ${eta}**`;
          if (summary) outcomeMsg += `\n📋 **Summary:** ${summary}`;
          if (!eta && !summary) outcomeMsg += `\nCheck your dashboard for details.`;
        } else {
          outcomeMsg = `⚠️ Call ended — ${endReason || 'unknown reason'}.`;
        }

        await interaction.followUp({ content: outcomeMsg }).catch(() => {});
      }
    } catch(err) {
      console.error(`Poll error (${polls}/${MAX_POLLS}):`, err.message);
      if (polls >= MAX_POLLS) {
        clearInterval(interval);
        await interaction.followUp({ content: `⏱️ Lost track of the call to **${order.vendor.name}**. Check your dashboard.` }).catch(() => {});
      }
    }
  }, POLL_INTERVAL);
}

client.login(process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN);
