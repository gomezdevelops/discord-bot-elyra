// src/commands/duel.js
// XP duel system — challenge, accept, decline, cancel.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getLevelColor } = require('../utils/xpHandler');

const DUEL_EXPIRE_MS = 5 * 60_000; // 5 minutes to accept

module.exports = {
  data: new SlashCommandBuilder()
    .setName('duel')
    .setDescription('Challenge another user to an XP duel!')
    .addSubcommand(sub =>
      sub
        .setName('challenge')
        .setDescription('Challenge a user to a duel.')
        .addUserOption(opt =>
          opt.setName('opponent').setDescription('Who do you want to duel?').setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('wager').setDescription('XP to wager (min 10)').setMinValue(10).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('accept').setDescription('Accept an incoming duel challenge.')
    )
    .addSubcommand(sub =>
      sub.setName('decline').setDescription('Decline an incoming duel challenge.')
    )
    .addSubcommand(sub =>
      sub.setName('cancel').setDescription('Cancel your outgoing duel challenge.')
    )
    .addSubcommand(sub =>
      sub
        .setName('history')
        .setDescription('View your recent duel history.')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to check (defaults to you)').setRequired(false)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const userId  = interaction.user.id;

    // ── CHALLENGE ───────────────────────────────────────────────────────────
    if (sub === 'challenge') {
      const opponent = interaction.options.getUser('opponent');
      const wager    = interaction.options.getInteger('wager');

      if (opponent.id === userId) {
        return interaction.editReply({ embeds: [errorEmbed('You can\'t duel yourself!')] });
      }
      if (opponent.bot) {
        return interaction.editReply({ embeds: [errorEmbed('You can\'t duel a bot!')] });
      }

      // Check duel cooldown
      const config   = db.getGuildConfig(guildId);
      const cooldown = db.getDuelCooldown(userId, guildId);
      if (cooldown) {
        const remaining = config.duel_cooldown_ms - (Date.now() - cooldown.last_duel);
        if (remaining > 0) {
          const secs = Math.ceil(remaining / 1000);
          return interaction.editReply({
            embeds: [errorEmbed(`You're on duel cooldown! Wait **${secs}s** before challenging again.`)],
          });
        }
      }

      // Check for existing pending duel by this challenger
      const existing = db.getPendingDuelByChallenger(guildId, userId);
      if (existing && Date.now() - existing.created_at < DUEL_EXPIRE_MS) {
        return interaction.editReply({
          embeds: [errorEmbed('You already have a pending challenge! Use `/duel cancel` to cancel it.')],
        });
      }

      // Check balances
      const challengerData = db.getUser(userId, guildId);
      const opponentData   = db.getUser(opponent.id, guildId);

      if (challengerData.xp < wager) {
        return interaction.editReply({
          embeds: [errorEmbed(`You don't have enough XP! You have **${challengerData.xp.toLocaleString()}** but need **${wager.toLocaleString()}**.`)],
        });
      }
      if (opponentData.xp < wager) {
        return interaction.editReply({
          embeds: [errorEmbed(`${opponent.displayName} doesn't have enough XP to cover the wager (**${wager.toLocaleString()} XP** needed, they have **${opponentData.xp.toLocaleString()}**).`)],
        });
      }

      db.createDuel(guildId, userId, opponent.id, wager);

      const embed = new EmbedBuilder()
        .setColor(0xFF6B35)
        .setTitle('⚔️ Duel Challenge!')
        .setDescription(
          `<@${userId}> has challenged ${opponent} to an **XP Duel**!\n\n` +
          `**Wager:** ${wager.toLocaleString()} XP\n` +
          `${opponent}, use \`/duel accept\` or \`/duel decline\` within 5 minutes.`
        )
        .addFields(
          { name: '🗡️ Challenger', value: `<@${userId}> (Lv. ${challengerData.level} · ${challengerData.xp.toLocaleString()} XP)`, inline: true },
          { name: '🛡️ Opponent',   value: `${opponent} (Lv. ${opponentData.level} · ${opponentData.xp.toLocaleString()} XP)`, inline: true },
        )
        .setFooter({ text: 'Challenge expires in 5 minutes' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── ACCEPT ──────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const duel = db.getPendingDuel(guildId, userId);

      if (!duel) {
        return interaction.editReply({ embeds: [errorEmbed("You don't have any pending duel challenge.")] });
      }

      // Check if it expired
      if (Date.now() - duel.created_at > DUEL_EXPIRE_MS) {
        db.cancelDuel(duel.id);
        return interaction.editReply({ embeds: [errorEmbed('That challenge has expired.')] });
      }

      // Verify both users still have enough XP
      const challengerData = db.getUser(duel.challenger, guildId);
      const opponentData   = db.getUser(userId, guildId);

      if (challengerData.xp < duel.wager || opponentData.xp < duel.wager) {
        db.cancelDuel(duel.id);
        return interaction.editReply({
          embeds: [errorEmbed("One of you no longer has enough XP for the wager. Duel cancelled.")],
        });
      }

      // 50/50 coin flip
      const challengerWins = Math.random() < 0.5;
      const winnerId = challengerWins ? duel.challenger : userId;
      const loserId  = challengerWins ? userId : duel.challenger;

      db.resolveDuel(duel.id, winnerId);
      const { actualWager, winnerNewXp, loserNewXp } = db.recordDuelResult(guildId, winnerId, loserId, duel.wager);

      // Set cooldowns for both
      db.setDuelCooldown(duel.challenger, guildId);
      db.setDuelCooldown(userId, guildId);

      const embed = new EmbedBuilder()
        .setColor(getLevelColor(db.getUser(winnerId, guildId).level))
        .setTitle('⚔️ Duel Result!')
        .setDescription(
          `The duel is over! After an intense battle...\n\n` +
          `🏆 **<@${winnerId}> wins** and takes **${actualWager.toLocaleString()} XP!**`
        )
        .addFields(
          {
            name: '🏆 Winner',
            value: `<@${winnerId}>\nNew XP: **${winnerNewXp.toLocaleString()}**`,
            inline: true,
          },
          {
            name: '💀 Loser',
            value: `<@${loserId}>\nNew XP: **${loserNewXp.toLocaleString()}**`,
            inline: true,
          }
        )
        .setFooter({ text: 'Better luck next time! Use /duel challenge to rematch.' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── DECLINE ─────────────────────────────────────────────────────────────
    if (sub === 'decline') {
      const duel = db.getPendingDuel(guildId, userId);
      if (!duel) {
        return interaction.editReply({ embeds: [errorEmbed("You don't have any pending duel challenge.")] });
      }

      db.cancelDuel(duel.id);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle('⚔️ Duel Declined')
            .setDescription(`<@${userId}> has declined the duel challenge from <@${duel.challenger}>.`)
            .setTimestamp(),
        ],
      });
    }

    // ── CANCEL ──────────────────────────────────────────────────────────────
    if (sub === 'cancel') {
      const duel = db.getPendingDuelByChallenger(guildId, userId);
      if (!duel || Date.now() - duel.created_at > DUEL_EXPIRE_MS) {
        return interaction.editReply({ embeds: [errorEmbed("You don't have any active outgoing challenge.")] });
      }

      db.cancelDuel(duel.id);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle('⚔️ Challenge Cancelled')
            .setDescription(`Your duel challenge against <@${duel.opponent}> has been cancelled.`)
            .setTimestamp(),
        ],
      });
    }

    // ── HISTORY ─────────────────────────────────────────────────────────────
    if (sub === 'history') {
      const target  = interaction.options.getUser('user') ?? interaction.user;
      const history = db.getDuelHistory(guildId, target.id);

      if (!history.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95A5A6)
              .setTitle('⚔️ Duel History')
              .setDescription(`${target.displayName} hasn't participated in any duels yet.`)
              .setTimestamp(),
          ],
        });
      }

      const userData = db.getUser(target.id, guildId);
      const wins     = userData.duel_wins   || 0;
      const losses   = userData.duel_losses || 0;
      const total    = wins + losses;
      const winRate  = total > 0 ? Math.floor((wins / total) * 100) : 0;

      const lines = history.map(duel => {
        const won = duel.winner === target.id;
        const otherId = duel.challenger === target.id ? duel.opponent : duel.challenger;
        const when = new Date(duel.resolved_at).toLocaleDateString();
        return `${won ? '🏆' : '💀'} **vs <@${otherId}>** · ${won ? 'Won' : 'Lost'} **${duel.wager.toLocaleString()} XP** · ${when}`;
      });

      const embed = new EmbedBuilder()
        .setColor(getLevelColor(userData.level))
        .setTitle(`⚔️ ${target.displayName}'s Duel History`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: '🏆 Wins',      value: `**${wins}**`,       inline: true },
          { name: '💀 Losses',    value: `**${losses}**`,     inline: true },
          { name: '📊 Win Rate',  value: `**${winRate}%**`,   inline: true },
          { name: 'Recent Duels', value: lines.join('\n') }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },
};

function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle('❌ Error')
    .setDescription(message)
    .setTimestamp();
}