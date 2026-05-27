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

client.commands    = new Collection();
client.activeDuels = new Map(); // channelId → gameState

const commandsDir  = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
const commandData  = [];

for (const file of commandFiles) {
  const command = require(path.join(commandsDir, file));
  client.commands.set(command.data.name, command);
  commandData.push(command.data.toJSON());
}

// Grab duel word handler from the duel command module
const duelModule = require('./commands/duel');

// ─── Message XP Cooldown Store ────────────────────────────────────────────────
const messageCooldowns = new Map();

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅  Logged in as ${readyClient.user.tag}`);

  readyClient.user.setActivity('your duels ⚔️', { type: ActivityType.Watching });

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commandData });
    console.log(`✅  Registered ${commandData.length} slash command(s) globally.`);
  } catch (err) {
    console.error('❌  Failed to register slash commands:', err);
  }

  const sessions = db.getAllVoiceSessions();
  if (sessions.length) console.log(`🔄  Restoring ${sessions.length} voice session(s).`);

  setInterval(voiceTick, 60_000);
});

// ─── Interaction Handler ──────────────────────────────────────────────────────

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

// ─── Message Handler ──────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.member) return;

  const channelId = message.channel.id;

  // ── Duel word processing (takes priority over XP) ──────────────────────
  const gameState = client.activeDuels.get(channelId);
  if (gameState && gameState.active) {
    const word   = message.content.trim().toLowerCase();
    const userId = message.author.id;

    // Only process single words (no spaces)
    if (/^[a-z]+$/.test(word)) {
      const result = duelModule.handleDuelWord(gameState, userId, word);

      if (result === 'valid') {
        const pts = word.length;
        const totalWords = gameState.wordCounts[userId];
        const totalScore = gameState.scores[userId];

        // React with a checkmark to the message
        await message.react('✅').catch(() => {});

        // Update the game message with live scores
        if (gameState.gameMsg) {
          const chalScore = gameState.scores[gameState.challenger] || 0;
          const oppScore  = gameState.scores[gameState.opponent]   || 0;
          const chalWords = gameState.wordCounts[gameState.challenger] || 0;
          const oppWords  = gameState.wordCounts[gameState.opponent]   || 0;
          const elapsed   = Date.now() - gameState.startedAt;
          const remaining = Math.max(0, Math.round((30000 - elapsed) / 1000));

          const letterDisplay = gameState.letters.map(l => `**${l.toUpperCase()}**`).join('  ');

          gameState.gameMsg.edit({
            embeds: [
              {
                color: 0x5B8FFF,
                title: '🔤 Word Duel — IN PROGRESS',
                description: `**Your letters:**\n\n${letterDisplay}\n\n⏱️ **${remaining}s remaining**`,
                fields: [
                  { name: '🗡️ Challenger', value: `<@${gameState.challenger}>\n${chalWords} words · **${chalScore} pts**`, inline: true },
                  { name: '🛡️ Opponent',   value: `<@${gameState.opponent}>\n${oppWords} words · **${oppScore} pts**`,     inline: true },
                ],
                footer: { text: `⚔️ Wager: ${gameState.wager.toLocaleString()} XP · Last word: "${word}" (+${pts} pts)` },
                timestamp: new Date().toISOString(),
              },
            ],
          }).catch(() => {});
        }

      } else if (result === 'already_claimed') {
        // React with ❌ — word already taken
        await message.react('❌').catch(() => {});

      } else if (result === 'invalid') {
        // No reaction for invalid — avoids spamming reactions on random chat
        // Only react if the message author is one of the players
        if (userId === gameState.challenger || userId === gameState.opponent) {
          await message.react('🚫').catch(() => {});
        }
      }
    }

    return; // Don't award normal XP during an active duel
  }

  // ── Normal message XP ───────────────────────────────────────────────────
  const config = db.getGuildConfig(message.guild.id);
  const key    = `${message.author.id}-${message.guild.id}`;
  const now    = Date.now();
  const last   = messageCooldowns.get(key) ?? 0;

  if (now - last < config.message_cooldown_ms) return;

  messageCooldowns.set(key, now);

  const xpAmount = randomInt(config.message_xp_min, config.message_xp_max);
  await awardXp(message.member, xpAmount, message.channel);
});

// ─── Voice State XP ───────────────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId     = newState.id;
  const guildId    = newState.guild.id;
  const wasInVoice = !!oldState.channelId;
  const isInVoice  = !!newState.channelId;
  const afkId      = newState.guild.afkChannelId;

  if (!wasInVoice && isInVoice) {
    if (!isMutedOrDeafened(newState) && newState.channelId !== afkId)
      db.startVoiceSession(userId, guildId);
    return;
  }

  if (wasInVoice && !isInVoice) {
    db.endVoiceSession(userId, guildId);
    return;
  }

  if (wasInVoice && isInVoice) {
    const wasEligible = !isMutedOrDeafened(oldState) && oldState.channelId !== afkId;
    const isEligible  = !isMutedOrDeafened(newState) && newState.channelId !== afkId;
    if (wasEligible && !isEligible) db.endVoiceSession(userId, guildId);
    else if (!wasEligible && isEligible) db.startVoiceSession(userId, guildId);
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

      if (!member) { db.endVoiceSession(session.user_id, session.guild_id); continue; }

      const vs  = member.voice;
      const afk = guild.afkChannelId;

      if (!vs.channelId || isMutedOrDeafened(vs) || vs.channelId === afk) {
        db.endVoiceSession(session.user_id, session.guild_id);
        continue;
      }

      await awardXp(member, config.voice_xp_per_min, null);
    } catch (err) {
      console.error('[Voice Tick] Error:', session, err);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isMutedOrDeafened(vs) {
  return vs.selfMute || vs.selfDeaf || vs.serverMute || vs.serverDeaf;
}

// ─── Login ────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('❌  DISCORD_TOKEN not set.'); process.exit(1); }

client.login(token);