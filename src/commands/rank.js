// src/commands/rank.js

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getLevelColor } = require('../utils/xpHandler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription("Check your (or another user's) XP rank.")
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to check (defaults to you)').setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const target  = interaction.options.getUser('user') ?? interaction.user;
    const guildId = interaction.guildId;

    const userData = db.getUser(target.id, guildId);
    const rank     = db.getUserRank(target.id, guildId);
    const { current, needed } = db.getProgress(userData.xp, userData.level);
    const bar      = db.buildProgressBar(current, needed, 20);
    const pct      = Math.floor((current / needed) * 100);

    const wins   = userData.duel_wins   || 0;
    const losses = userData.duel_losses || 0;
    const total  = wins + losses;
    const winRate = total > 0 ? Math.floor((wins / total) * 100) : 0;

    const embed = new EmbedBuilder()
      .setColor(getLevelColor(userData.level))
      .setAuthor({
        name:    `${target.displayName}'s Rank Card`,
        iconURL: target.displayAvatarURL({ dynamic: true }),
      })
      .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }));

    if (userData.title) {
      embed.setDescription(`*"${userData.title}"*`);
    }

    embed.addFields(
      { name: '🏅 Rank',       value: `**#${rank ?? '—'}**`,                   inline: true },
      { name: '⭐ Level',      value: `**${userData.level}**`,                  inline: true },
      { name: '✨ Total XP',   value: `**${userData.xp.toLocaleString()}**`,    inline: true },
      { name: '⚔️ Duel Wins',  value: `**${wins}**`,                            inline: true },
      { name: '💀 Losses',     value: `**${losses}**`,                          inline: true },
      { name: '📊 Win Rate',   value: `**${winRate}%**`,                        inline: true },
      {
        name:  `Progress to Level ${userData.level + 1} — ${pct}%`,
        value: `\`${bar}\`\n**${current.toLocaleString()} / ${needed.toLocaleString()} XP** · ${(needed - current).toLocaleString()} XP remaining`,
      }
    )
    .setFooter({ text: `Daily streak: ${userData.daily_streak || 0} day(s) 🔥` })
    .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};