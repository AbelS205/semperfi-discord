require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
    new SlashCommandBuilder()
      .setName('order')
      .setDescription('Place a parts order call to an HVAC vendor')
      .addStringOption(opt =>
                             opt.setName('brand')
                               .setDescription('Equipment brand (e.g. Carrier, Lennox, Goodman)')
                               .setRequired(true)
                           )
      .addStringOption(opt =>
                             opt.setName('part')
                               .setDescription('Part description (e.g. dual run capacitor 45/5 MFD)')
                               .setRequired(true)
                           )
      .addStringOption(opt =>
                             opt.setName('po')
                               .setDescription('PO number (e.g. PO-2025-0442)')
                               .setRequired(true)
                           )
      .addIntegerOption(opt =>
                              opt.setName('qty')
                                .setDescription('Quantity (default: 1)')
                                .setRequired(false)
                                .setMinValue(1)
                            )
      .addStringOption(opt =>
                             opt.setName('model')
                               .setDescription('Model number (optional)')
                               .setRequired(false)
                           ),
  ].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
          console.log('Registering slash commands...');
          await rest.put(
                  Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
                  { body: commands }
                );
          console.log('Slash commands registered successfully!');
        } catch (err) {
          console.error('Failed to register commands:', err);
          process.exit(1);
        }
  })();
