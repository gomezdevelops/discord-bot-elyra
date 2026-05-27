// src/commands/leaderboard.js

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');

const MEDALS = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the top 10 XP earners in this server.'),

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    const rows    = db.getLeaderboard(guildId);

    if (!rows.length) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle('📊 Leaderboard')
            .setDescription('No users have earned XP yet. Start chatting!')
            .setTimestamp(),
        ],
      });
    }

    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let displayName = `<@${row.user_id}>`;

      try {
        const member = await interaction.guild.members.fetch(row.user_id).catch(() => null);
        if (member) displayName = member.displayName;
      } catch { /* keep mention fallback */ }

      const medal  = MEDALS[i] ?? `**\`${i + 1}.\`**`;
      const { current, needed } = db.getProgress(row.xp, row.level);
      const pct    = Math.floor((current / needed) * 100);
      const wins   = row.duel_wins || 0;
      const losses = row.duel_losses || 0;
      const titleStr = row.title ? ` *"${row.title}"*` : '';

      lines.push(
        `${medal} **${displayName}**${titleStr}\n` +
        `　Lv.**${row.level}** · ${row.xp.toLocaleString()} XP · ${pct}% next · ⚔️ ${wins}W/${losses}L`
      );
    }

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(`🏆 ${interaction.guild.name} — XP Leaderboard`)
      .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `Top ${rows.length} members · Use /rank to see your position` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};