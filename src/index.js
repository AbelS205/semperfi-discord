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
async function lookupBrandFromModel(modelNumber) {
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `What HVAC brand makes the unit with model number "${modelNumber}"? Search for it and respond ONLY with a JSON object like this, no other text:
{
  "brand": "one of: Carrier, Bryant, Payne, Lennox, Allied, Rheem, Ruud, Trane, American Standard, Goodman, Amana, Daikin, York, Bosch, Coleman, Luxaire, JCI, AC Pro, Maytag, or Unknown",
  "confidence": "high, medium, or low"
}`
      }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      }
    });

    // Extract the text response (may come after tool use blocks)
    const textBlock = resp.data.content.find(b => b.type === 'text');
    if (!textBlock) return null;

    const parsed = JSON.parse(textBlock.text.replace(/```json|```/g,'').trim());
    if (parsed.brand && parsed.brand !== 'Unknown') return parsed.brand;
    return null;
  } catch(err) {
    console.error('Brand lookup error:', err.response?.data || err.message);
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
  // Poll every 5 seconds for up to 10 minutes (120 polls)
  // OpenAI Realtime calls can run several minutes
  const MAX_POLLS    = 120;
  const POLL_INTERVAL = 5000;

  // Terminal statuses from Twilio
  const TERMINAL = ['completed','failed','busy','no-answer','canceled'];

  const interval = setInterval(async () => {
    polls++;
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/call-status/${callSid}`);
      const status   = data.status;

      // Update embed to show live status while call is in progress
      if (!TERMINAL.includes(status) && polls % 3 === 0) {
        // Every 15 seconds update the embed with current status
        await interaction.editReply({
          embeds: [buildOrderEmbed({ ...order, status:'calling', callSid, liveStatus: status })],
          components: [],
        }).catch(() => {});
      }

      // Call finished or timed out
      if (TERMINAL.includes(status) || polls >= MAX_POLLS) {
        clearInterval(interval);

        const timedOut = polls >= MAX_POLLS && !TERMINAL.includes(status);
        const success  = status === 'completed';

        // Final embed
        const finalEmbed = buildOrderEmbed({
          ...order,
          status:   success ? 'completed' : 'error',
          callSid,
          error:    timedOut
            ? 'Call status timed out — check dashboard for result'
            : (!success ? `Call ended with status: ${status}` : null),
        });

        await interaction.editReply({ embeds: [finalEmbed], components: [] }).catch(() => {});

        // Post a follow-up outcome message in the channel
        const outcomeLines = {
          completed:  `✅ **Call completed** — Alex finished the call with **${order.vendor.name}** for PO \`${order.po}\`.\nCheck your dashboard for order status.`,
          failed:     `❌ **Call failed** — Could not connect to **${order.vendor.name}**. Try calling again.`,
          busy:       `📵 **Line busy** — **${order.vendor.name}** was busy. Try again in a few minutes.`,
          'no-answer':`📭 **No answer** — **${order.vendor.name}** did not pick up. Try again or call directly.`,
          canceled:   `🚫 **Call canceled** — The call to **${order.vendor.name}** was canceled.`,
        };

        const outcomeMsg = timedOut
          ? `⏱️ **Call in progress** — Alex is still on the line with **${order.vendor.name}**. Check the dashboard for the final result.`
          : (outcomeLines[status] || `ℹ️ Call ended with status: **${status}**`);

        await interaction.followUp({ content: outcomeMsg }).catch(() => {});
      }
    } catch(err) {
      // Don't kill the interval on a single failed request — just log and keep trying
      console.error(`Poll error (${polls}/${MAX_POLLS}):`, err.message);
      if (polls >= MAX_POLLS) {
        clearInterval(interval);
        await interaction.followUp({ content: `⏱️ Lost track of the call to **${order.vendor.name}**. Check your dashboard for the result.` }).catch(() => {});
      }
    }
  }, POLL_INTERVAL);
}

client.login(process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN);
