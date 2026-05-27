// src/commands/level-config.js
// Admin command: add or remove role rewards tied to specific levels.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('level-config')
    .setDescription('⚙️ Configure level-up role rewards for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Assign a role reward to a specific level.')
        .addIntegerOption(opt =>
          opt.setName('level').setDescription('The level at which the role is awarded (min 1)').setMinValue(1).setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('The role to award').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove the role reward for a specific level.')
        .addIntegerOption(opt =>
          opt.setName('level').setDescription('The level whose reward should be removed').setMinValue(1).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List all configured role rewards for this server.')
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ You need the **Manage Server** permission to use this command.',
        ephemeral: true,
      });
    }

    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'add') {
      const level = interaction.options.getInteger('level');
      const role  = interaction.options.getRole('role');

      const botMember = interaction.guild.members.me;
      if (role.position >= botMember.roles.highest.position) {
        return interaction.reply({
          embeds: [errorEmbed('Role Hierarchy Error',
            `I cannot assign **${role.name}** because it is ranked equal to or above my highest role.\n` +
            'Move my role above it in **Server Settings → Roles**.'
          )],
          ephemeral: true,
        });
      }

      if (role.id === interaction.guildId) {
        return interaction.reply({
          embeds: [errorEmbed('Invalid Role', 'You cannot use **@everyone** as a reward.')],
          ephemeral: true,
        });
      }

      db.setRoleReward(guildId, level, role.id, role.name);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('✅ Role Reward Set')
            .setDescription(`Users who reach **Level ${level}** will now receive the ${role} role.`)
            .setTimestamp(),
        ],
      });
    }

    if (sub === 'remove') {
      const level   = interaction.options.getInteger('level');
      const deleted = db.removeRoleReward(guildId, level);

      if (!deleted) {
        return interaction.reply({
          embeds: [errorEmbed('Not Found', `No role reward is configured for Level ${level}.`)],
          ephemeral: true,
        });
      }

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('🗑️ Role Reward Removed')
            .setDescription(`The role reward for **Level ${level}** has been removed.`)
            .setTimestamp(),
        ],
      });
    }

    if (sub === 'list') {
      const rewards = db.getRoleRewards(guildId);

      if (!rewards.length) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95A5A6)
              .setTitle('📋 Role Rewards')
              .setDescription('No role rewards configured yet.\nUse `/level-config add` to set one up.')
              .setTimestamp(),
          ],
        });
      }

      const lines = rewards.map(r => `**Level ${r.level}** → <@&${r.role_id}>`);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('📋 Configured Role Rewards')
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${rewards.length} reward(s) configured` })
            .setTimestamp(),
        ],
      });
    }
  },
};

function errorEmbed(title, desc) {
  return new EmbedBuilder().setColor(0xE74C3C).setTitle(`❌ ${title}`).setDescription(desc).setTimestamp();
}