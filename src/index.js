// src/index.js
// Entry point — initialises the Discord client, loads commands,
// and wires up all event listeners.

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  REST,
  Routes,
  ActivityType,
} = require('discord.js');

const fs   = require('fs');
const path = require('path');
const db   = require('./database');
const { awardXp } = require('./utils/xpHandler');

// ─── Client Setup ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ─── Commands ─────────────────────────────────────────────────────────────────

client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
const commandData = [];

for (const file of commandFiles) {
  const command = require(path.join(commandsDir, file));
  client.commands.set(command.data.name, command);
  commandData.push(command.data.toJSON());
}

// ─── Message XP Cooldown Store ────────────────────────────────────────────────
const messageCooldowns = new Map();

// ─── Events ───────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅  Logged in as ${readyClient.user.tag}`);

  readyClient.user.setActivity('your levels 📈', { type: ActivityType.Watching });

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      { body: commandData }
    );
    console.log(`✅  Registered ${commandData.length} slash command(s) globally.`);
  } catch (err) {
    console.error('❌  Failed to register slash commands:', err);
  }

  const sessions = db.getAllVoiceSessions();
  if (sessions.length) {
    console.log(`🔄  Restoring ${sessions.length} voice session(s).`);
  }

  // Expire stale pending duels every 5 minutes
  setInterval(expireStaleDuels, 300_000);

  // Start voice XP ticker — uses per-guild config
  setInterval(voiceTick, 60_000);
});

// ── Slash Command Dispatch ─────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`[Command: ${interaction.commandName}]`, err);
    const msg = { content: '❌ An error occurred executing this command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ── Message XP ────────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.member) return;

  const config = db.getGuildConfig(message.guild.id);
  const key    = `${message.author.id}-${message.guild.id}`;
  const now    = Date.now();
  const last   = messageCooldowns.get(key) ?? 0;

  if (now - last < config.message_cooldown_ms) return;

  messageCooldowns.set(key, now);

  const xpAmount = randomInt(config.message_xp_min, config.message_xp_max);
  await awardXp(message.member, xpAmount, message.channel);
});

// ── Voice State XP ────────────────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId  = newState.id;
  const guildId = newState.guild.id;
  const wasInVoice = !!oldState.channelId;
  const isInVoice  = !!newState.channelId;

  // Don't track AFK channel
  const afkChannelId = newState.guild.afkChannelId;

  if (!wasInVoice && isInVoice) {
    if (!isMutedOrDeafened(newState) && newState.channelId !== afkChannelId) {
      db.startVoiceSession(userId, guildId);
    }
    return;
  }

  if (wasInVoice && !isInVoice) {
    db.endVoiceSession(userId, guildId);
    return;
  }

  if (wasInVoice && isInVoice) {
    const wasEligible = !isMutedOrDeafened(oldState) && oldState.channelId !== afkChannelId;
    const isEligible  = !isMutedOrDeafened(newState) && newState.channelId !== afkChannelId;

    if (wasEligible && !isEligible) {
      db.endVoiceSession(userId, guildId);
    } else if (!wasEligible && isEligible) {
      db.startVoiceSession(userId, guildId);
    }
  }
});

// ─── Voice XP Ticker ──────────────────────────────────────────────────────────

async function voiceTick() {
  const sessions = db.getAllVoiceSessions();

  for (const session of sessions) {
    try {
      const guild = client.guilds.cache.get(session.guild_id);
      if (!guild) continue;

      const config = db.getGuildConfig(session.guild_id);
      const member = await guild.members.fetch(session.user_id).catch(() => null);

      if (!member) {
        db.endVoiceSession(session.user_id, session.guild_id);
        continue;
      }

      const voiceState = member.voice;
      const afkId = guild.afkChannelId;

      if (!voiceState.channelId || isMutedOrDeafened(voiceState) || voiceState.channelId === afkId) {
        db.endVoiceSession(session.user_id, session.guild_id);
        continue;
      }

      await awardXp(member, config.voice_xp_per_min, null);
    } catch (err) {
      console.error('[Voice Tick] Error:', session, err);
    }
  }
}

// ─── Duel Expiry ──────────────────────────────────────────────────────────────

function expireStaleDuels() {
  // Duels older than 5 minutes that are still pending get auto-cancelled
  // (handled at query time in the duel command)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isMutedOrDeafened(voiceState) {
  return (
    voiceState.selfMute   ||
    voiceState.selfDeaf   ||
    voiceState.serverMute ||
    voiceState.serverDeaf
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌  DISCORD_TOKEN is not set in your .env file.');
  process.exit(1);
}

client.login(token);