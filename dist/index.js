import { GuildPremiumTier, GuildDefaultMessageNotifications, GuildFeature, GuildExplicitContentFilter, GuildVerificationLevel, GuildSystemChannelFlags, OverwriteType, ChannelType, IntentsBitField, GatewayIntentBits, SnowflakeUtil } from 'discord.js';
import Bottleneck from 'bottleneck';
import axios from 'axios';
import path from 'path';
import url from 'url';
import fs from 'fs';

const MAX_BITRATE_PER_TIER = {
  [GuildPremiumTier.None]: 64e3,
  [GuildPremiumTier.Tier1]: 128e3,
  [GuildPremiumTier.Tier2]: 256e3,
  [GuildPremiumTier.Tier3]: 384e3
};
function fetchChannelPermissions(channel) {
  const permissions = [];
  channel.permissionOverwrites.cache.filter((permission) => permission.type == OverwriteType.Role).forEach((permission) => {
    const role = channel.guild.roles.cache.get(permission.id);
    if (role) {
      permissions.push({
        roleName: role.name,
        allow: permission.allow.bitfield.toString(),
        deny: permission.deny.bitfield.toString()
      });
    }
  });
  return permissions;
}
function fetchVoiceChannelData(channel) {
  return {
    type: ChannelType.GuildVoice,
    name: channel.name,
    bitrate: channel.bitrate,
    userLimit: channel.userLimit,
    parent: channel.parent ? channel.parent.name : null,
    permissions: fetchChannelPermissions(channel)
  };
}
async function fetchStageChannelData(channel, options, limiter) {
  const channelData = {
    type: ChannelType.GuildStageVoice,
    name: channel.name,
    nsfw: channel.nsfw,
    rateLimitPerUser: channel.rateLimitPerUser,
    topic: channel.topic,
    bitrate: channel.bitrate,
    userLimit: channel.userLimit,
    parent: channel.parent ? channel.parent.name : null,
    permissions: fetchChannelPermissions(channel),
    messages: []
  };
  try {
    channelData.messages = await fetchChannelMessages(channel, options, limiter);
    return channelData;
  } catch {
    return channelData;
  }
}
async function fetchChannelMessages(channel, options, limiter) {
  const messages = [];
  const messageCount = isNaN(options.maxMessagesPerChannel) ? 10 : options.maxMessagesPerChannel;
  const fetchOptions = { limit: messageCount < 100 ? messageCount : 100 };
  let lastMessageId;
  let fetchComplete = false;
  while (!fetchComplete) {
    if (lastMessageId)
      fetchOptions.before = lastMessageId;
    const fetched = await limiter.schedule({ id: `fetchChannelMessages::channel.messages.fetch::${channel.id}` }, () => channel.messages.fetch(fetchOptions));
    if (fetched.size == 0)
      break;
    lastMessageId = fetched.last().id;
    await Promise.all(fetched.map(async (message) => {
      if (!message.author || messages.length >= messageCount) {
        fetchComplete = true;
        return;
      }
      if (message.cleanContent.length > 2e3)
        return;
      const files = await Promise.all(message.attachments.map(async (attachment) => {
        if (attachment.url && ["png", "jpg", "jpeg", "jpe", "jif", "jfif", "jfi"].includes(attachment.url.split(".").pop())) {
          if (options.saveImages && options.saveImages == "base64") {
            const response = await axios.get(attachment.url, { responseType: "arraybuffer" });
            const buffer = Buffer.from(response.data, "binary").toString("base64");
            return { name: attachment.name, attachment: buffer };
          }
        }
        return { name: attachment.name, attachment: attachment.url };
      }));
      messages.push({
        oldId: message.id,
        userId: message.author.id,
        username: message.author.username,
        avatar: message.author.displayAvatarURL(),
        content: message.cleanContent,
        embeds: message.embeds,
        components: message.components,
        files,
        pinned: message.pinned,
        sentAt: message.createdAt.toISOString()
      });
    }));
  }
  return messages;
}
async function fetchTextChannelData(channel, options, limiter) {
  const channelData = {
    type: channel.type,
    name: channel.name,
    nsfw: channel.nsfw,
    rateLimitPerUser: channel.type == ChannelType.GuildText ? channel.rateLimitPerUser : void 0,
    parent: channel.parent ? channel.parent.name : null,
    topic: channel.topic,
    permissions: fetchChannelPermissions(channel),
    messages: [],
    isNews: channel.type == ChannelType.GuildAnnouncement,
    threads: []
  };
  if (channel.threads.cache.size > 0) {
    channel.threads.cache.forEach(async (thread) => {
      const threadData = {
        type: thread.type,
        name: thread.name,
        archived: thread.archived,
        autoArchiveDuration: thread.autoArchiveDuration,
        locked: thread.locked,
        rateLimitPerUser: thread.rateLimitPerUser,
        messages: []
      };
      try {
        threadData.messages = await fetchChannelMessages(thread, options, limiter);
        channelData.threads.push(threadData);
      } catch {
        channelData.threads.push(threadData);
      }
    });
  }
  try {
    channelData.messages = await fetchChannelMessages(channel, options, limiter);
    return channelData;
  } catch {
    return channelData;
  }
}
async function loadCategory(categoryData, guild, limiter) {
  const category = await limiter.schedule({ id: `loadCategory::guild.channels.create::${categoryData.name}` }, () => guild.channels.create({ name: categoryData.name, type: ChannelType.GuildCategory }));
  const finalPermissions = [];
  categoryData.permissions.forEach((permission) => {
    const role = guild.roles.cache.find((role2) => role2.name == permission.roleName);
    if (role) {
      finalPermissions.push({
        id: role.id,
        allow: BigInt(permission.allow),
        deny: BigInt(permission.deny)
      });
    }
  });
  await limiter.schedule({ id: `loadCategory::category.permissionOverwrites.set::${category.name}` }, () => category.permissionOverwrites.set(finalPermissions));
  return category;
}
async function loadChannel(channelData, guild, category, options, limiter) {
  const loadMessages = async (channel2, messages, previousWebhook) => {
    const webhook = previousWebhook || await limiter.schedule({ id: `loadMessages::channel.createWebhook::${channel2.name}` }, () => channel2.createWebhook({ name: "MessagesBackup", avatar: channel2.client.user.displayAvatarURL() }));
    if (!webhook)
      return;
    messages = messages.filter((message) => message.content.length > 0 || message.embeds.length > 0 || message.files.length > 0).reverse();
    if (options.maxMessagesPerChannel && options.maxMessagesPerChannel < messages.length) {
      messages = messages.slice(messages.length - options.maxMessagesPerChannel);
    }
    for (let message of messages) {
      if (message.content.length > 2e3)
        continue;
      try {
        let sent;
        if ((message == null ? void 0 : message.userId) == channel2.client.user.id) {
          sent = await limiter.schedule({ id: `loadMessages::channel.send::${channel2.name}` }, () => channel2.send({
            content: message.content.length ? message.content : void 0,
            embeds: message.embeds,
            components: message.components,
            files: message.files,
            allowedMentions: options.allowedMentions
          }));
        } else {
          sent = await limiter.schedule({ id: `loadMessages::webhook.send::${channel2.name}` }, () => webhook.send({
            content: message.content.length ? message.content : void 0,
            username: message.username,
            avatarURL: message.avatar,
            embeds: message.embeds,
            components: message == null ? void 0 : message.components,
            //Send message components with backwards compatibility
            files: message.files,
            allowedMentions: options.allowedMentions,
            threadId: channel2.isThread() ? channel2.id : void 0
          }));
        }
        if (message.pinned && sent)
          await limiter.schedule({ id: `loadMessages::sent.pin::${channel2.name}` }, () => sent.pin());
      } catch (error) {
        if (error.message == "Request entity too large")
          return;
        console.error(error);
      }
    }
    return webhook;
  };
  const createOptions = { name: channelData.name, type: null, parent: category };
  if (channelData.type == ChannelType.GuildText || channelData.type == ChannelType.GuildAnnouncement) {
    createOptions.topic = channelData.topic;
    createOptions.nsfw = channelData.nsfw;
    createOptions.rateLimitPerUser = channelData.rateLimitPerUser;
    createOptions.type = channelData.isNews && guild.features.includes(GuildFeature.News) ? ChannelType.GuildAnnouncement : ChannelType.GuildText;
  } else if (channelData.type == ChannelType.GuildVoice) {
    let bitrate = channelData.bitrate;
    const bitrates = Object.values(MAX_BITRATE_PER_TIER);
    while (bitrate > MAX_BITRATE_PER_TIER[guild.premiumTier]) {
      bitrate = bitrates[guild.premiumTier];
    }
    createOptions.bitrate = bitrate;
    createOptions.userLimit = channelData.userLimit;
    createOptions.type = channelData.type;
  } else if (channelData.type == ChannelType.GuildStageVoice) {
    let bitrate = channelData.bitrate;
    const bitrates = Object.values(MAX_BITRATE_PER_TIER);
    while (bitrate > MAX_BITRATE_PER_TIER[guild.premiumTier]) {
      bitrate = bitrates[guild.premiumTier];
    }
    createOptions.topic = channelData.topic;
    createOptions.nsfw = channelData.nsfw;
    createOptions.rateLimitPerUser = channelData.rateLimitPerUser;
    createOptions.bitrate = bitrate;
    createOptions.userLimit = channelData.userLimit;
    createOptions.type = channelData.type;
    if (!guild.features.includes(GuildFeature.Community))
      return null;
  }
  const channel = await limiter.schedule({ id: `loadChannel::guild.channels.create::${channelData.name}` }, () => guild.channels.create(createOptions));
  const finalPermissions = [];
  channelData.permissions.forEach((permission) => {
    const role = guild.roles.cache.find((role2) => role2.name == permission.roleName);
    if (role) {
      finalPermissions.push({
        id: role.id,
        allow: BigInt(permission.allow),
        deny: BigInt(permission.deny)
      });
    }
  });
  await limiter.schedule({ id: `loadChannel::channel.permissionOverwrites.set::${channel.name}` }, () => channel.permissionOverwrites.set(finalPermissions));
  if (channelData.type == ChannelType.GuildText) {
    let webhook;
    if (channelData.messages.length > 0) {
      webhook = await loadMessages(channel, channelData.messages);
    }
    if (channelData.threads.length > 0) {
      channelData.threads.forEach(async (threadData) => {
        const thread = await limiter.schedule({ id: `loadChannel::channel.threads.create::${threadData.name}` }, () => channel.threads.create({ name: threadData.name, autoArchiveDuration: threadData.autoArchiveDuration }));
        if (webhook)
          await loadMessages(thread, threadData.messages, webhook);
      });
    }
  } else if (channelData.type == ChannelType.GuildStageVoice) {
    if (channelData.messages.length > 0) {
      await loadMessages(channel, channelData.messages);
    }
  }
  return channel;
}
async function clearGuild(guild, limiter) {
  const roles = guild.roles.cache.filter((role) => !role.managed && role.editable && role.id != guild.id);
  roles.forEach(async (role) => await limiter.schedule({ id: `clearGuild::role.delete::${role.id}` }, () => role.delete().catch((error) => console.error(`Error occurred while deleting roles: ${error.message}`))));
  guild.channels.cache.forEach(async (channel) => {
    if (channel == null ? void 0 : channel.deletable) {
      await limiter.schedule({ id: `clearGuild::channel.delete::${channel.id}` }, () => channel.delete().catch((error) => console.error(`Error occurred while deleting channels: ${error.message}`)));
    }
  });
  guild.emojis.cache.forEach(async (emoji) => await limiter.schedule({ id: `clearGuild::emoji.delete::${emoji.id}` }, () => emoji.delete().catch((error) => console.error(`Error occurred while deleting emojis: ${error.message}`))));
  const webhooks = await limiter.schedule({ id: "clearGuild::guild.fetchWebhooks" }, () => guild.fetchWebhooks());
  webhooks.forEach(async (webhook) => await limiter.schedule({ id: `clearGuild::webhook.delete::${webhook.id}` }, () => webhook.delete().catch((error) => console.error(`Error occurred while deleting webhooks: ${error.message}`))));
  const bans = await limiter.schedule({ id: "clearGuild::guild.bans.fetch" }, () => guild.bans.fetch());
  bans.forEach(async (ban) => await limiter.schedule({ id: `clearGuild::guild.members.unban::${ban.user.id}` }, () => guild.members.unban(ban.user).catch((error) => console.error(`Error occurred while deleting bans: ${error.message}`))));
  await limiter.schedule({ id: "clearGuild::guild.setAFKChannel" }, () => guild.setAFKChannel(null));
  await limiter.schedule({ id: "clearGuild::guild.setAFKTimeout" }, () => guild.setAFKTimeout(60 * 5));
  await limiter.schedule({ id: "clearGuild::guild.setIcon" }, () => guild.setIcon(null));
  await limiter.schedule({ id: "clearGuild::guild.setBanner" }, () => guild.setBanner(null));
  await limiter.schedule({ id: "clearGuild::guild.setSplash" }, () => guild.setSplash(null));
  await limiter.schedule({ id: "clearGuild::guild.setDefaultMessageNotifications" }, () => guild.setDefaultMessageNotifications(GuildDefaultMessageNotifications.OnlyMentions));
  await limiter.schedule({ id: "clearGuild::guild.setWidgetSettings" }, () => guild.setWidgetSettings({ enabled: false, channel: null }));
  if (!guild.features.includes(GuildFeature.Community)) {
    await limiter.schedule({ id: "clearGuild::guild.setExplicitContentFilter" }, () => guild.setExplicitContentFilter(GuildExplicitContentFilter.Disabled));
    await limiter.schedule({ id: "clearGuild::guild.setVerificationLevel" }, () => guild.setVerificationLevel(GuildVerificationLevel.None));
  }
  await limiter.schedule({ id: "clearGuild::guild.setSystemChannel" }, () => guild.setSystemChannel(null));
  await limiter.schedule({ id: "clearGuild::guild.setSystemChannelFlags" }, () => guild.setSystemChannelFlags([
    GuildSystemChannelFlags.SuppressGuildReminderNotifications,
    GuildSystemChannelFlags.SuppressJoinNotifications,
    GuildSystemChannelFlags.SuppressPremiumSubscriptions
  ]));
  await limiter.schedule({ id: "clearGuild::guild.setPremiumProgressBarEnabled" }, () => guild.setPremiumProgressBarEnabled(false));
  const rules = await limiter.schedule({ id: "clearGuild::guild.autoModerationRules.fetch" }, () => guild.autoModerationRules.fetch());
  rules.forEach(async (rule) => await limiter.schedule({ id: `clearGuild::rule.delete::${rule.id}` }, () => rule.delete().catch((error) => console.error(`Error occurred while deleting automod rules: ${error.message}`))));
}

async function getBans(guild, limiter) {
  const bans = await limiter.schedule({ id: "getBans::guild.bans.fetch" }, () => guild.bans.fetch());
  return bans.map((ban) => ({ id: ban.user.id, reason: ban.reason }));
}
async function getMembers(guild, limiter) {
  const members = await limiter.schedule({ id: "getMembers::guild.members.fetch" }, () => guild.members.fetch());
  return members.map((member) => ({
    userId: member.user.id,
    username: member.user.username,
    discriminator: member.user.discriminator,
    avatarUrl: member.user.avatarURL(),
    joinedTimestamp: member.joinedTimestamp,
    roles: member.roles.cache.map((role) => role.id),
    bot: member.user.bot
  }));
}
async function getRoles(guild, limiter) {
  const roles = await limiter.schedule({ id: "getRoles::guild.roles.fetch" }, () => guild.roles.fetch());
  return roles.filter((role) => !role.managed).sort((a, b) => b.position - a.position).map((role) => ({
    oldId: role.id,
    name: role.name,
    color: role.hexColor,
    icon: role.iconURL(),
    hoist: role.hoist,
    permissions: role.permissions.bitfield.toString(),
    mentionable: role.mentionable,
    position: role.position,
    isEveryone: guild.id == role.id
  }));
}
async function getEmojis(guild, options, limiter) {
  const emojis = await limiter.schedule({ id: "getEmojis::guild.emojis.fetch" }, () => guild.emojis.fetch());
  const collectedEmojis = [];
  emojis.forEach(async (emoji) => {
    if (emojis.length >= 50)
      return;
    const data = { name: emoji.name };
    if (options.saveImages && options.saveImages == "base64") {
      const response = await axios.get(emoji.url, { responseType: "arraybuffer" });
      data.base64 = Buffer.from(response.data, "binary").toString("base64");
    } else {
      data.url = emoji.url;
    }
    collectedEmojis.push(data);
  });
  return collectedEmojis;
}
async function getChannels(guild, options, limiter) {
  const channels = await limiter.schedule({ id: "getChannels::guild.channels.fetch" }, () => guild.channels.fetch());
  const collectedChannels = { categories: [], others: [] };
  const categories = channels.filter((channel) => channel.type == ChannelType.GuildCategory).sort((a, b) => a.position - b.position).toJSON();
  for (let category of categories) {
    const categoryData = { name: category.name, permissions: fetchChannelPermissions(category), children: [] };
    const children = category.children.cache.sort((a, b) => a.position - b.position).toJSON();
    for (let child of children) {
      let channelData;
      if (child.type == ChannelType.GuildText || child.type == ChannelType.GuildAnnouncement) {
        channelData = await fetchTextChannelData(child, options, limiter);
      } else if (child.type == ChannelType.GuildVoice) {
        channelData = fetchVoiceChannelData(child);
      } else if (child.type == ChannelType.GuildStageVoice) {
        channelData = await fetchStageChannelData(child, options, limiter);
      } else {
        console.warn(`Unsupported channel type: ${child.type}`);
      }
      if (channelData) {
        channelData.oldId = child.id;
        categoryData.children.push(channelData);
      }
    }
    collectedChannels.categories.push(categoryData);
  }
  const others = channels.filter((channel) => {
    return !channel.parent && channel.type != ChannelType.GuildCategory && channel.type != ChannelType.AnnouncementThread && channel.type != ChannelType.PrivateThread && channel.type != ChannelType.PublicThread;
  }).sort((a, b) => a.position - b.position).toJSON();
  for (let channel of others) {
    let channelData;
    if (channel.type == ChannelType.GuildText || channel.type == ChannelType.GuildAnnouncement) {
      channelData = await fetchTextChannelData(channel, options, limiter);
    } else {
      channelData = fetchVoiceChannelData(channel);
    }
    if (channelData) {
      channelData.oldId = channel.id;
      collectedChannels.others.push(channelData);
    }
  }
  return collectedChannels;
}
async function getAutoModerationRules(guild, limiter) {
  const rules = await limiter.schedule({ id: "getAutoModerationRules::guild.autoModerationRules.fetch" }, () => guild.autoModerationRules.fetch({ cache: false }));
  const collectedRules = [];
  rules.forEach((rule) => {
    const actions = [];
    rule.actions.forEach((action) => {
      const copyAction = JSON.parse(JSON.stringify(action));
      if (copyAction.metadata.channelId) {
        const channel = guild.channels.cache.get(copyAction.metadata.channelId);
        if (channel) {
          copyAction.metadata.channelName = channel.name;
          actions.push(copyAction);
        }
      } else {
        actions.push(copyAction);
      }
    });
    const exemptRoles = rule.exemptRoles.filter((role) => role != void 0);
    const exemptChannels = rule.exemptChannels.filter((channel) => channel != void 0);
    collectedRules.push({
      name: rule.name,
      eventType: rule.eventType,
      triggerType: rule.triggerType,
      triggerMetadata: rule.triggerMetadata,
      actions,
      enabled: rule.enabled,
      exemptRoles: exemptRoles.map((role) => ({ id: role.id, name: role.name })),
      exemptChannels: exemptChannels.map((channel) => ({ id: channel.id, name: channel.name }))
    });
  });
  return collectedRules;
}
var createFunctions = {
  getBans,
  getMembers,
  getRoles,
  getEmojis,
  getChannels,
  getAutoModerationRules
};

async function loadConfig(guild, backup, limiter) {
  if (backup.name) {
    await limiter.schedule({ id: "loadConfig::guild.setName" }, () => guild.setName(backup.name));
  }
  if (backup.iconBase64) {
    await limiter.schedule({ id: "loadConfig::guild.setIcon" }, () => guild.setIcon(Buffer.from(backup.iconBase64, "base64")));
  } else if (backup.iconURL) {
    await limiter.schedule({ id: "loadConfig::guild.setIcon" }, () => guild.setIcon(backup.iconURL));
  }
  if (backup.splashBase64) {
    await limiter.schedule({ id: "loadConfig::guild.setSplash" }, () => guild.setSplash(Buffer.from(backup.splashBase64, "base64")));
  } else if (backup.splashURL) {
    await limiter.schedule({ id: "loadConfig::guild.setSplash" }, () => guild.setSplash(backup.splashURL));
  }
  if (backup.bannerBase64) {
    await limiter.schedule({ id: "loadConfig::guild.setBanner" }, () => guild.setBanner(Buffer.from(backup.bannerBase64, "base64")));
  } else if (backup.bannerURL) {
    await limiter.schedule({ id: "loadConfig::guild.setBanner" }, () => guild.setBanner(backup.bannerURL));
  }
  if (backup.verificationLevel) {
    await limiter.schedule({ id: "loadConfig::guild.setVerificationLevel" }, () => guild.setVerificationLevel(backup.verificationLevel));
  }
  if (backup.defaultMessageNotifications) {
    await limiter.schedule({ id: "loadConfig::guild.setDefaultMessageNotifications" }, () => guild.setDefaultMessageNotifications(backup.defaultMessageNotifications));
  }
  const changeableExplicitLevel = guild.features.includes(GuildFeature.Community);
  if (backup.explicitContentFilter && changeableExplicitLevel) {
    await limiter.schedule({ id: "loadConfig::guild.setExplicitContentFilter" }, () => guild.setExplicitContentFilter(backup.explicitContentFilter));
  }
  backup.roleMap = {};
  backup.channelMap = {};
}
async function loadRoles(guild, backup, limiter) {
  for (let role of backup.roles) {
    try {
      if (role.isEveryone) {
        await limiter.schedule({ id: `loadRoles::guild.roles.edit::everyone` }, () => guild.roles.edit(guild.roles.everyone, {
          permissions: BigInt(role.permissions),
          mentionable: role.mentionable
        }));
        backup.roleMap[role.oldId] = guild.roles.everyone;
      } else {
        const createdRole = await limiter.schedule({ id: `loadRoles::guild.roles.create::${role.name}` }, () => guild.roles.create({
          name: role.name,
          color: role.color,
          icon: role.icon,
          hoist: role.hoist,
          permissions: BigInt(role.permissions),
          mentionable: role.mentionable,
          position: role.position
        }));
        backup.roleMap[role.oldId] = createdRole;
      }
    } catch (error) {
      console.error(error.message);
    }
  }
}
async function loadChannels(guild, backup, options, limiter) {
  for (let category of backup.channels.categories) {
    const createdCategory = await loadCategory(category, guild, limiter);
    for (let channel of category.children) {
      const createdChannel = await loadChannel(channel, guild, createdCategory, options, limiter);
      if (createdChannel)
        backup.channelMap[channel.oldId] = createdChannel;
    }
  }
  for (let channel of backup.channels.others) {
    const createdChannel = await loadChannel(channel, guild, null, options, limiter);
    if (createdChannel)
      backup.channelMap[channel.oldId] = createdChannel;
  }
}
async function loadAutoModRules(guild, backup, limiter) {
  var _a, _b;
  if (backup.autoModerationRules.length === 0)
    return;
  const roles = await limiter.schedule({ id: "loadAutoModRules::guild.roles.fetch" }, () => guild.roles.fetch());
  const channels = await limiter.schedule({ id: "loadAutoModRules::guild.channels.fetch" }, () => guild.channels.fetch());
  for (const autoModRule of backup.autoModerationRules) {
    let actions = [];
    for (const action of autoModRule.actions) {
      let copyAction = JSON.parse(JSON.stringify(action));
      if (action.metadata.channelName) {
        const filteredFirstChannel = channels.filter((channel) => channel.name === action.metadata.channelName && backup.channelMap[action.metadata.channelId] === channel).first();
        if (filteredFirstChannel) {
          copyAction.metadata.channel = filteredFirstChannel.id;
          copyAction.metadata.channelName = null;
          actions.push(copyAction);
        }
      } else {
        copyAction.metadata.channel = null;
        copyAction.metadata.channelName = null;
        actions.push(copyAction);
      }
    }
    const data = {
      name: autoModRule.name,
      eventType: autoModRule.eventType,
      triggerType: autoModRule.triggerType,
      triggerMetadata: autoModRule.triggerMetadata,
      actions,
      enabled: autoModRule.enabled,
      exemptRoles: (_a = autoModRule.exemptRoles) == null ? void 0 : _a.map((exemptRole) => {
        const filteredFirstRole = roles.filter((role) => role.name === exemptRole.name && backup.roleMap[exemptRole.id] === role).first();
        if (filteredFirstRole)
          return filteredFirstRole.id;
      }),
      exemptChannels: (_b = autoModRule.exemptChannels) == null ? void 0 : _b.map((exemptChannel) => {
        const filteredFirstChannel = channels.filter((channel) => channel.name === exemptChannel.name && backup.channelMap[exemptChannel.id] === channel).first();
        if (filteredFirstChannel)
          return filteredFirstChannel.id;
      })
    };
    await limiter.schedule({ id: "loadAutoModRules::guild.autoModerationRules.create" }, () => guild.autoModerationRules.create(data));
  }
}
async function loadAFk(guild, backup, limiter) {
  if (backup.afk) {
    try {
      await limiter.schedule({ id: "loadAFK::guild.setAFKChannel" }, () => guild.setAFKChannel(guild.channels.cache.find((channel) => channel.name == backup.afk.name && channel.type == ChannelType.GuildVoice)));
      await limiter.schedule({ id: "loadAFK::guild.setAFKTimeout" }, () => guild.setAFKTimeout(backup.afk.timeout));
    } catch (error) {
      console.error(error.message);
    }
  }
}
async function loadEmojis(guild, backup, limiter) {
  for (let emoji of backup.emojis) {
    try {
      if (emoji.url) {
        await limiter.schedule({ id: `loadEmojis::guild.emojis.create::${emoji.name}` }, () => guild.emojis.create({ name: emoji.name, attachment: emoji.url }));
      } else if (emoji.base64) {
        await limiter.schedule({ id: `loadEmojis::guild.emojis.create::${emoji.name}` }, () => guild.emojis.create({ name: emoji.name, attachment: Buffer.from(emoji.base64, "base64") }));
      }
    } catch (error) {
      console.error(error.message);
    }
  }
}
async function loadBans(guild, backup, limiter) {
  for (let ban of backup.bans) {
    try {
      await limiter.schedule({ id: `loadBans::guild.members.ban::${ban.id}` }, () => guild.members.ban(ban.id, { reason: ban.reason }));
    } catch (error) {
      console.error(error.message);
    }
  }
}
async function loadEmbedChannel(guild, backup, limiter) {
  if (backup.widget.channel) {
    try {
      await limiter.schedule({ id: "loadEmbedChannel::guild.setWidgetSettings" }, () => guild.setWidgetSettings({
        enabled: backup.widget.enabled,
        channel: guild.channels.cache.find((channel) => channel.name == backup.widget.channel)
      }));
    } catch (error) {
      console.error(error.message);
    }
  }
}
async function loadFinalSettings(guild, backup, limiter) {
  if (backup.systemChannel) {
    const channels = await limiter.schedule({ id: "loadFinalSettings::guild.channels.fetch" }, () => guild.channels.fetch());
    const filteredFirstChannel = channels.filter((channel) => channel.name === backup.systemChannel.name).first();
    await limiter.schedule({ id: "loadFinalSettings::guild.setSystemChannel" }, () => guild.setSystemChannel(filteredFirstChannel));
    await limiter.schedule({ id: "loadFinalSettings::guild.setSystemChannelFlags" }, () => guild.setSystemChannelFlags(backup.systemChannel.flags));
  }
  if (backup.premiumProgressBarEnabled) {
    await limiter.schedule({ id: "loadFinalSettings::guild.setPremiumProgressBarEnabled" }, () => guild.setPremiumProgressBarEnabled(backup.premiumProgressBarEnabled));
  }
}
async function assignRolesToMembers(guild, backup, limiter) {
  const members = await limiter.schedule({ id: "assignRolesToMembers::guild.members.fetch" }, () => guild.members.fetch());
  for (let backupMember of backup.members) {
    if (!backupMember.bot) {
      const member = members.get(backupMember.userId);
      if (member) {
        const roles = backupMember.roles.map((oldRoleId) => {
          const newRole = backup.roleMap[oldRoleId];
          return newRole ? newRole.id : null;
        });
        await limiter.schedule({ id: `assignRolesToMembers::member.edit::${member.id}` }, () => member.edit({ roles }));
      }
    }
  }
}
var loadFunctions = {
  loadConfig,
  loadRoles,
  loadChannels,
  loadAutoModRules,
  loadAFk,
  loadEmojis,
  loadBans,
  loadEmbedChannel,
  loadFinalSettings,
  assignRolesToMembers
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
let backups = `${__dirname}/backups`;
if (!fs.existsSync(backups))
  fs.mkdirSync(backups);
async function getBackupData(backupId) {
  return new Promise((resolve, reject) => {
    const files = fs.readdirSync(backups);
    const file = files.filter((file2) => file2.split(".").pop() == "json").find((file2) => file2 == `${backupId}.json`);
    if (file) {
      const backupData = JSON.parse(fs.readFileSync(`${backups}${path.sep}${file}`));
      resolve(backupData);
    } else {
      reject("No backup found");
    }
  });
}
async function fetch(backupId) {
  try {
    const backupData = await getBackupData(backupId);
    const size = fs.statSync(`${backups}${path.sep}${backupId}.json`).size;
    return {
      data: backupData,
      id: backupId,
      size: Number((size / 1024).toFixed(2))
    };
  } catch {
    throw new Error("No backup found.");
  }
}
async function create(guild, options = {}) {
  const intents = new IntentsBitField(guild.client.options.intents);
  if (!intents.has(GatewayIntentBits.Guilds))
    throw new Error("GUILDS intent is required");
  options = {
    backupId: null,
    maxMessagesPerChannel: 10,
    jsonSave: true,
    jsonBeautify: false,
    doNotBackup: [],
    backupMembers: false,
    saveImages: true,
    speed: 250,
    verbose: false,
    ...options
  };
  const backup = {
    name: guild.name,
    verificationLevel: guild.verificationLevel,
    explicitContentFilter: guild.explicitContentFilter,
    systemChannel: guild.systemChannel ? { name: guild.systemChannel.name, flags: guild.systemChannelFlags } : null,
    premiumProgressBarEnabled: guild.premiumProgressBarEnabled,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    afk: guild.afkChannel ? { name: guild.afkChannel.name, timeout: guild.afkTimeout } : null,
    widget: {
      enabled: guild.widgetEnabled,
      channel: guild.widgetChannel ? guild.widgetChannel.name : null
    },
    autoModerationRules: [],
    channels: { categories: [], others: [] },
    roles: [],
    bans: [],
    emojis: [],
    members: [],
    createdTimestamp: Date.now(),
    messagesPerChannel: options.maxMessagesPerChannel,
    guildID: guild.id,
    id: options.backupId ?? SnowflakeUtil.generate(Date.now())
  };
  const limiter = new Bottleneck({ minTime: options.speed, maxConcurrent: 1 });
  if (options.verbose) {
    limiter.on("executing", (jobInfo) => {
      console.log(`Executing ${jobInfo.options.id}.`);
    });
    limiter.on("done", (jobInfo) => {
      console.log(`Completed ${jobInfo.options.id}.`);
    });
  }
  limiter.on("error", async (error) => {
    if (error.message == "Request entity too large")
      return;
    console.error(`ERROR: ${error.message}`);
  });
  limiter.on("failed", (error, jobInfo) => {
    if (error.message == "Request entity too large")
      return;
    console.error(`Job Failed: ${error.message}
ID: ${jobInfo.options.id}`);
  });
  backup.autoModerationRules = await createFunctions.getAutoModerationRules(guild, limiter);
  if (guild.iconURL()) {
    if (options && options.saveImages && options.saveImages == "base64") {
      const response = await axios.get(guild.iconURL({ dynamic: true }), { responseType: "arraybuffer" });
      backup.iconBase64 = Buffer.from(response.data, "binary").toString("base64");
    }
    backup.iconURL = guild.iconURL({ dynamic: true });
  }
  if (guild.splashURL()) {
    if (options && options.saveImages && options.saveImages == "base64") {
      const response = await axios.get(guild.splashURL(), { responseType: "arraybuffer" });
      backup.splashBase64 = Buffer.from(response.data, "binary").toString("base64");
    }
    backup.splashURL = guild.splashURL();
  }
  if (guild.bannerURL()) {
    if (options && options.saveImages && options.saveImages == "base64") {
      const response = await axios.get(guild.bannerURL(), { responseType: "arraybuffer" });
      backup.bannerBase64 = Buffer.from(response.data, "binary").toString("base64");
    }
    backup.bannerURL = guild.bannerURL();
  }
  if (options && options.backupMembers) {
    backup.members = await createFunctions.getMembers(guild, limiter);
  }
  if (!options || !(options.doNotBackup || []).includes("bans")) {
    backup.bans = await createFunctions.getBans(guild, limiter);
  }
  if (!options || !(options.doNotBackup || []).includes("roles")) {
    backup.roles = await createFunctions.getRoles(guild, limiter);
  }
  if (!options || !(options.doNotBackup || []).includes("emojis")) {
    backup.emojis = await createFunctions.getEmojis(guild, options, limiter);
  }
  if (!options || !(options.doNotBackup || []).includes("channels")) {
    backup.channels = await createFunctions.getChannels(guild, options, limiter);
  }
  if (!options || options.jsonSave == void 0 || options.jsonSave) {
    const reviver = (key, value) => typeof value == "bigint" ? value.toString() : value;
    const backupJSON = options.jsonBeautify ? JSON.stringify(backup, reviver, 4) : JSON.stringify(backup, reviver);
    fs.writeFileSync(`${backups}${path.sep}${backup.id}.json`, backupJSON, "utf-8");
  }
  return backup;
}
async function load(backup, guild, options) {
  if (!guild)
    throw new Error("Invalid Guild!");
  options = { clearGuildBeforeRestore: true, maxMessagesPerChannel: 10, speed: 250, doNotLoad: [], verbose: false, ...options };
  const isBackupFromFetch = backup.id && backup.size && backup.data;
  const backupData = typeof backup == "string" ? await getBackupData(backup) : isBackupFromFetch ? backup.data : backup;
  if (typeof options.speed != "number") {
    throw new Error("Speed option must be a string or number");
  }
  const limiter = new Bottleneck({ minTime: options.speed, maxConcurrent: 1 });
  if (options.verbose) {
    limiter.on("executing", (jobInfo) => {
      console.log(`Executing ${jobInfo.options.id}.`);
    });
    limiter.on("done", (jobInfo) => {
      console.log(`Completed ${jobInfo.options.id}.`);
    });
  }
  limiter.on("error", async (error) => {
    if (error.message == "Request entity too large")
      return;
    console.error(`ERROR: ${error.message}`);
  });
  limiter.on("failed", (error, jobInfo) => {
    if (error.message == "Request entity too large")
      return;
    console.error(`Job Failed: ${error.message}
ID: ${jobInfo.options.id}`);
  });
  if (!options || !(options.doNotLoad || []).includes("main")) {
    if (options.clearGuildBeforeRestore == void 0 || options.clearGuildBeforeRestore) {
      await clearGuild(guild, limiter);
    }
    await Promise.all([
      loadFunctions.loadConfig(guild, backupData, limiter),
      loadFunctions.loadBans(guild, backupData, limiter)
    ]);
    await loadFunctions.loadRoles(guild, backupData, limiter);
    await loadFunctions.loadChannels(guild, backupData, options, limiter);
    await Promise.all([
      loadFunctions.loadAFk(guild, backupData, limiter),
      loadFunctions.loadEmbedChannel(guild, backupData, limiter),
      loadFunctions.loadAutoModRules(guild, backupData, limiter),
      loadFunctions.loadFinalSettings(guild, backupData, limiter)
    ]);
    if (!options || !(options.doNotLoad || []).includes("roleAssignments")) {
      await loadFunctions.assignRolesToMembers(guild, backupData, limiter);
    }
  }
  if (!options || !(options.doNotLoad || []).includes("emojis")) {
    await loadFunctions.loadEmojis(guild, backupData, limiter);
  }
  return backupData;
}
async function remove(backupId) {
  try {
    fs.unlinkSync(`${backups}${path.sep}${backupId}.json`);
  } catch {
    throw new Error("Backup not found");
  }
}
function list() {
  const files = fs.readdirSync(backups);
  return files.map((file) => file.split(".")[0]);
}
function setStorageFolder(pathname) {
  if (pathname.endsWith(path.sep))
    pathname = pathname.substr(0, pathname.length - 1);
  backups = pathname;
  if (!fs.existsSync(backups))
    fs.mkdirSync(backups);
}
var index = { create, fetch, list, load, remove, setStorageFolder };

export { index as default };
