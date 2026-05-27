// src/commands/daily.js
// Daily XP reward with streak bonuses.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getLevelColor } = require('../utils/xpHandler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily XP reward! Streak bonuses for consecutive days.'),

  async execute(interaction) {
    await interaction.deferReply();

    const result = db.claimDaily(interaction.user.id, interaction.guildId);

    if (!result.success) {
      const hours   = Math.floor(result.remaining / 3_600_000);
      const minutes = Math.floor((result.remaining % 3_600_000) / 60_000);
      const seconds = Math.floor((result.remaining % 60_000) / 1000);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('⏰ Already Claimed!')
            .setDescription(
              `You've already claimed your daily reward today.\n\n` +
              `Come back in **${hours}h ${minutes}m ${seconds}s**!`
            )
            .setTimestamp(),
        ],
      });
    }

    const { xpAwarded, streak, newXp, oldLevel, newLevel } = result;
    const leveledUp = newLevel > oldLevel;

    // Build streak display
    const streakEmojis = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌕', '🌟'];
    const streakBar = Array.from({ length: db.DAILY_STREAK_CAP }, (_, i) =>
      i < streak ? streakEmojis[Math.min(i, streakEmojis.length - 1)] : '⬛'
    ).join('');

    const embed = new EmbedBuilder()
      .setColor(streak >= 7 ? 0xFFD700 : getLevelColor(newLevel))
      .setTitle(streak >= 7 ? '🌟 MAX STREAK DAILY REWARD!' : '🎁 Daily Reward Claimed!')
      .setDescription(
        `You claimed your daily XP reward${leveledUp ? ` and leveled up to **Level ${newLevel}**!` : '!'}`
      )
      .addFields(
        { name: '✨ XP Earned',    value: `**+${xpAwarded.toLocaleString()} XP**`,   inline: true },
        { name: '💰 Total XP',     value: `**${newXp.toLocaleString()} XP**`,         inline: true },
        { name: '🔥 Streak',       value: `**${streak} / ${db.DAILY_STREAK_CAP} days**`, inline: true },
        { name: 'Streak Progress', value: streakBar }
      );

    if (streak < db.DAILY_STREAK_CAP) {
      const nextBonus = db.DAILY_BASE_XP + streak * 25;
      embed.setFooter({ text: `Come back tomorrow for ${nextBonus} XP! (+25 bonus per streak day)` });
    } else {
      embed.setFooter({ text: '🌟 Max streak! You\'re earning the max daily reward.' });
    }

    embed.setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};