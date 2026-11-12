'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  ActivityType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { Connectors, Shoukaku } = require('shoukaku');

const PREFIX = process.env.PREFIX || 'ed';
const STATE_FILE = path.resolve(process.env.STATE_FILE || 'state.json');
const MAX_QUEUE_SIZE = Number.parseInt(process.env.MAX_QUEUE_SIZE || '500', 10);
const DEFAULT_VOLUME = 70;
const LAVALINK_RETRIES = 3;
const LAVALINK_WAIT_TIMEOUT = Number.parseInt(process.env.LAVALINK_WAIT_TIMEOUT || '120000', 10);

const RADIO_STATIONS = {
  lofi: { name: 'Lofi Hip Hop', url: process.env.RADIO_LOFI_URL },
  chillsynth: { name: 'Chillsynth', url: process.env.RADIO_CHILLSYNTH_URL },
  jazz: { name: 'Smooth Jazz', url: process.env.RADIO_SMOOTH_JAZZ_URL },
  piano: { name: 'Peaceful Piano', url: process.env.RADIO_PEACEFUL_PIANO_URL }
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const nodes = [{
  name: process.env.LAVALINK_NAME || 'main',
  url: /:\d+$/.test(process.env.LAVALINK_HOST || '')
    ? process.env.LAVALINK_HOST
    : `${process.env.LAVALINK_HOST || '127.0.0.1'}:${process.env.LAVALINK_PORT || '2333'}`,
  auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
  secure: process.env.LAVALINK_SECURE === 'true'
}];
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
  moveOnDisconnect: false,
  resume: true,
  resumeTimeout: 30,
  resumeByLibrary: true,
  reconnectTries: 1000,
  reconnectInterval: 5,
  restTimeout: 10_000
});

async function waitForLavalink(timeoutMs = LAVALINK_WAIT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const node = shoukaku.getIdealNode();
    if (node) return node;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Lavalink chưa sẵn sàng sau ${Math.round(timeoutMs / 1000)} giây. Hãy kiểm tra docker logs lavalink.`);
}

const guildStates = new Map();
let spotifyToken = null;
let spotifyTokenExpiresAt = 0;
let spotifyAuthLogged = false;

function stateFor(guildId) {
  if (!guildStates.has(guildId)) {
    guildStates.set(guildId, {
      guildId,
      channelId: null,
      queue: [],
      current: null,
      volume: DEFAULT_VOLUME,
      stay247: false,
      mode: 'queue',
      station: null,
      playing: false,
      starting: false,
      transitioning: false,
      consecutiveFailures: 0,
      textChannelId: null,
      invitedByUserId: null
    });
  }

  return guildStates.get(guildId);
}

function duration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours} giờ ${String(minutes).padStart(2, '0')} phút ${String(seconds).padStart(2, '0')} giây`
    : `${minutes} phút ${String(seconds).padStart(2, '0')} giây`;
}

function totalDuration(state) {
  return (state.queue.reduce((sum, track) => sum + (track.duration || 0), 0)
    + (state.current?.duration || 0));
}

function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isSpotifyUrl(value) {
  return /^https?:\/\/open\.spotify\.com\/(intl-[^/]+\/)?(track|album|playlist)\//i.test(value);
}

function spotifyReference(value) {
  const match = value.match(/open\.spotify\.com\/(?:intl-[^/]+\/)?(track|album|playlist)\/([a-zA-Z0-9]+)/i);
  return match ? { type: match[1].toLowerCase(), id: match[2] } : null;
}

async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Thiếu SPOTIFY_CLIENT_ID hoặc SPOTIFY_CLIENT_SECRET.');
  if (spotifyToken && Date.now() < spotifyTokenExpiresAt) return spotifyToken;

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`Spotify token request thất bại (${response.status}).`);
  const data = await response.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiresAt = Date.now() + Math.max(30, data.expires_in - 60) * 1000;
  if (!spotifyAuthLogged) {
    spotifyAuthLogged = true;
    console.log('[Spotify] OAuth Client Credentials thành công (token không được ghi log).');
  }
  return spotifyToken;
}

async function spotifyRequest(endpoint) {
  const response = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${await getSpotifyToken()}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Spotify API thất bại (${response.status}): ${body.slice(0, 160)}`);
  }
  return response.json();
}

async function spotifyTracks(reference) {
  if (reference.type === 'track') {
    const track = await spotifyRequest(`tracks/${reference.id}`);
    return [{
      title: `${track.artists.map((artist) => artist.name).join(', ')} - ${track.name}`,
      query: `${track.artists.map((artist) => artist.name).join(', ')} - ${track.name} official audio`,
      duration: track.duration_ms,
      artworkUrl: track.album?.images?.[0]?.url || null
    }];
  }

  const first = await spotifyRequest(`${reference.type}s/${reference.id}`);
  const tracks = [];
  let items = first.tracks?.items || [];
  let next = first.tracks?.next;
  while (next) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${await getSpotifyToken()}` } });
    if (!response.ok) throw new Error(`Spotify pagination thất bại (${response.status}).`);
    const page = await response.json();
    items = items.concat(page.items || []);
    next = page.next;
  }

  for (const item of items) {
    const track = item.track || item;
    if (!track?.name || !track.artists?.length) continue;
    tracks.push({
      title: `${track.artists.map((artist) => artist.name).join(', ')} - ${track.name}`,
      query: `${track.artists.map((artist) => artist.name).join(', ')} - ${track.name} official audio`,
      duration: track.duration_ms || 0,
      artworkUrl: track.album?.images?.[0]?.url || first.images?.[0]?.url || null
    });
  }
  return tracks;
}

async function resolveLavalink(query) {
  let lastError = null;
  for (let attempt = 1; attempt <= LAVALINK_RETRIES; attempt += 1) {
    try {
      const node = await waitForLavalink();
      const result = await node.rest.resolve(query);
      if (!result) throw new Error('Lavalink không trả về kết quả.');
      if (result.loadType === 'empty') throw new Error('Lavalink không tìm thấy kết quả.');
      if (result.loadType === 'error') {
        throw new Error(`Lavalink resolve lỗi: ${result.data?.message || 'nguồn không khả dụng'}`);
      }
      if (result.loadType === 'search' || result.loadType === 'track') {
        const track = result.loadType === 'track' ? result.data : result.data?.[0];
        if (!track) throw new Error('Không tìm thấy bài hát.');
        return [track];
      }
      if (result.loadType === 'playlist') return result.data.tracks || [];
      throw new Error(`Lavalink trả về trạng thái không hỗ trợ: ${result.loadType}.`);
    } catch (error) {
      lastError = error;
      if (attempt < LAVALINK_RETRIES) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError || new Error('Không thể truy vấn Lavalink.');
}

async function resolveRequest(input) {
  if (isSpotifyUrl(input)) {
    const reference = spotifyReference(input);
    if (!reference) throw new Error('Link Spotify không hợp lệ.');
    const spotifyItems = await spotifyTracks(reference);
    const resolved = [];
    const skipped = [];
    for (const item of spotifyItems) {
      try {
        const tracks = await resolveSearchTrack(item.query);
        if (!tracks[0]) {
          skipped.push(item.title);
          continue;
        }
        resolved.push({
          encoded: tracks[0].encoded,
          title: item.title,
          uri: tracks[0].info?.uri || null,
          duration: item.duration || tracks[0].info?.length || 0,
          artworkUrl: item.artworkUrl,
          requester: null
        });
      } catch (error) {
        skipped.push(item.title);
        console.warn(`[Spotify] Bỏ qua "${item.title}": ${error.message}`);
      }
    }
    return {
      tracks: resolved,
      skipped,
      playlistName: reference.type === 'track' ? null : 'Spotify collection'
    };
  }

  const tracks = isUrl(input)
    ? await resolveLavalink(input)
    : await resolveSearchTrack(input);
  return {
    tracks: tracks.map((track) => ({
      encoded: track.encoded,
      title: track.info?.author ? `${track.info.author} - ${track.info.title}` : track.info?.title || 'Unknown track',
      uri: track.info?.uri || null,
      duration: track.info?.length || 0,
      artworkUrl: track.info?.artworkUrl || null,
      requester: null
    })),
    playlistName: tracks.length > 1 ? 'Playlist' : null,
    skipped: []
  };
}

async function resolveSearchTrack(query) {
  const searchPrefixes = ['ytsearch:', 'ytmsearch:'];
  let lastError = null;
  for (const prefix of searchPrefixes) {
    try {
      const tracks = await resolveLavalink(`${prefix}${query}`);
      if (tracks.length) return tracks;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Không tìm thấy bài hát cho: ${query}`);
}

async function ensurePlayer(guild, channelId) {
  await waitForLavalink();
  const state = stateFor(guild.id);
  const actualChannelId = guild.members.me?.voice?.channelId || null;
  if (actualChannelId && actualChannelId !== channelId) {
  const existing = shoukaku.players.get(guild.id);
  if (existing) await shoukaku.leaveVoiceChannel(guild.id);
  }
  if (actualChannelId === channelId || !actualChannelId) state.channelId = channelId;
  const existing = shoukaku.players.get(guild.id);
  if (existing) return existing;
  const player = await shoukaku.joinVoiceChannel({
    guildId: guild.id,
    shardId: guild.shardId ?? 0,
    channelId,
    deaf: true,
    mute: false
  });
  player.on('start', async () => {
    const currentState = stateFor(guild.id);
    const current = currentState.current;
    currentState.playing = true;
    currentState.consecutiveFailures = 0;
    console.log(`[Player:${guild.id}] Bắt đầu phát: ${current?.title || 'track không có metadata'}`);
    if (currentState.textChannelId && current) {
      const channel = await client.channels.fetch(currentState.textChannelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send(`▶️ Đang phát: **${current.title}**`).catch((error) => {
          console.warn(`[Player:${guild.id}] Không thể gửi Now Playing: ${error.message}`);
        });
      }
    }
    await saveState();
  });
  player.on('end', async (data) => {
    const state = stateFor(guild.id);
    console.log(`[Player:${guild.id}] Track kết thúc: ${data?.reason || 'unknown'}`);
    if (data?.reason === 'loadFailed') return;
    state.playing = false;
    setTimeout(() => playNext(guild.id).catch((error) => {
      console.error(`[Player:${guild.id}] Không thể phát track kế tiếp:`, error);
    }), 100);
  });
  player.on('exception', async (error) => {
    console.error(`[Player:${guild.id}] Track exception:`, error);
    const state = stateFor(guild.id);
    const failedTrack = state.current;
    state.playing = false;
    state.consecutiveFailures += 1;
    if (state.mode === 'radio' && state.consecutiveFailures >= 3) {
      state.current = null;
      await saveState();
      console.error(`[Player:${guild.id}] Dừng radio sau ${state.consecutiveFailures} lỗi liên tiếp.`);
      return;
    }
    if (state.mode === 'queue') {
      state.current = null;
      await saveState();
      if (state.textChannelId && failedTrack?.title) {
        const channel = await client.channels.fetch(state.textChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send(`⚠️ Không thể tải audio: **${failedTrack.title}**. Đã bỏ qua track lỗi.`).catch(() => {});
        }
      }
    }
    setTimeout(() => playNext(guild.id).catch((nextError) => {
      console.error(`[Player:${guild.id}] Không thể phục hồi player:`, nextError);
    }), 100);
  });
  player.on('stuck', async (threshold) => {
    console.warn(`[Player:${guild.id}] Kẹt sau ${threshold}ms.`);
    await player.stopTrack();
  });
  player.on('closed', (reason) => console.warn(`[Player:${guild.id}] Đóng:`, reason));
  player.on('update', (data) => {
    const position = data.state?.position || 0;
    if (position === 0 || position % 30_000 < 1_000) {
      console.log(`[Player:${guild.id}] Voice update: position=${position}ms, ping=${data.state?.ping ?? player.ping}ms, connected=${data.state?.connected}`);
    }
  });
  return player;
}

async function playEncoded(player, encoded, volume) {
  if (!encoded) throw new Error('Track Lavalink không có mã encoded.');
  console.log(`[Player:${player.guildId}] Gửi track tới Lavalink, volume=${volume}`);
  await player.playTrack({
    track: { encoded }
  });
  await player.setGlobalVolume(Math.max(1, Math.min(100, Number(volume) || DEFAULT_VOLUME)));
  stateFor(player.guildId).playing = true;
  console.log(`[Player:${player.guildId}] Lavalink đã nhận track.`);
}

async function playNext(guildId) {
  const state = stateFor(guildId);
  const player = shoukaku.players.get(guildId);
  if (!player) return;
  if (state.transitioning) return;
  state.transitioning = true;
  try {
    if (state.mode === 'radio' && state.station) {
      state.current = state.station;
      await playEncoded(player, state.station.encoded, state.volume);
      state.playing = true;
      await saveState();
      return;
    }
    const next = state.queue[0];
    if (!next) {
      state.current = null;
      state.playing = false;
      await saveState();
      return;
    }
    state.current = next;
    await playEncoded(player, next.encoded, state.volume);
    state.queue.shift();
    state.playing = true;
    await saveState();
    console.log(`[Player:${guildId}] Current track: ${next.title}; remaining=${state.queue.length}`);
  } finally {
    state.transitioning = false;
  }
}

async function startRadio(guild, stationKey, channelId) {
  const station = RADIO_STATIONS[stationKey];
  if (!station?.url) throw new Error(`Radio "${stationKey}" chưa được cấu hình URL.`);
  const tracks = await resolveLavalink(station.url);
  if (!tracks[0]?.encoded) throw new Error(`Radio "${station.name}" không trả về audio hợp lệ.`);
  const state = stateFor(guild.id);
  const player = await ensurePlayer(guild, channelId);
  state.mode = 'radio';
  state.station = {
    encoded: tracks[0].encoded,
    title: station.name,
    duration: tracks[0].info?.length || 0,
    artworkUrl: tracks[0].info?.artworkUrl || null
  };
  state.queue = [];
  state.current = state.station;
  await playEncoded(player, state.station.encoded, state.volume);
  state.playing = true;
  await saveState();
}

async function saveState() {
  const data = Object.fromEntries(guildStates);
  await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function loadState() {
  try {
    const data = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (data.guildId) {
      const state = { ...stateFor(data.guildId), ...data, playing: false, transitioning: false };
      if (state.mode === 'queue' && state.current?.encoded) {
        state.queue.unshift(state.current);
        state.current = null;
      }
      guildStates.set(data.guildId, state);
      return;
    }
    for (const [guildId, state] of Object.entries(data)) {
      if (state && typeof state === 'object' && state.guildId) {
        const restored = { ...stateFor(guildId), ...state, playing: false, transitioning: false };
        if (restored.mode === 'queue' && restored.current?.encoded) {
          restored.queue.unshift(restored.current);
          restored.current = null;
        }
        guildStates.set(guildId, restored);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[State] Không thể đọc state.json:', error.message);
  }
}

function requestedVoiceChannel(guild, member, requestedChannel = null) {
  if (requestedChannel) {
    if (!requestedChannel.isVoiceBased()) throw new Error('room phải là voice channel.');
    return requestedChannel;
  }
  if (member?.voice?.channel) return member.voice.channel;
  const state = stateFor(guild.id);
  if (state.channelId) return guild.channels.cache.get(state.channelId) || null;
  if (process.env.DEFAULT_VOICE_CHANNEL_ID) {
    const configured = guild.channels.cache.get(process.env.DEFAULT_VOICE_CHANNEL_ID);
    if (configured?.isVoiceBased()) return configured;
  }
  return guild.channels.cache.find((channel) =>
    channel.isVoiceBased() && channel.joinable !== false
  ) || null;
}

function voiceChannel(interaction) {
  const channel = requestedVoiceChannel(interaction.guild, interaction.member);
  if (!channel) throw new Error('Bạn phải vào phòng thoại trước hoặc dùng /join room:<room>.');
  return channel;
}

async function handleJoin(target, requestedChannel = null, pendingReply = null) {
  const guild = target.guild;
  const channel = requestedVoiceChannel(guild, target.member, requestedChannel);
  if (!channel) throw new Error('Chọn room hoặc vào một phòng thoại trước.');
  const state = stateFor(guild.id);
  state.textChannelId = target.channel?.id || state.textChannelId;
  const wasSameChannel = state.channelId === channel.id;
  await ensurePlayer(guild, channel.id);
  state.channelId = channel.id;
  if (!wasSameChannel || !state.invitedByUserId) {
    state.invitedByUserId = target.user?.id || target.author?.id;
  }
  await saveState();
  const content = `✅ Đã vào <#${channel.id}>. Chỉ người mời bot mới có thể dùng /leave hoặc edl.`;
  const response = pendingReply ? pendingReply.edit(content) : reply(target, content);
  await response;

  if (!state.playing && !state.starting) {
    state.starting = true;
    await saveState();
    startRadio(guild, 'lofi', channel.id)
      .then(async () => {
        state.starting = false;
        await saveState();
        if (state.textChannelId) {
          const textChannel = await client.channels.fetch(state.textChannelId).catch(() => null);
          if (textChannel?.isTextBased()) await textChannel.send('📻 Đang phát Lofi.').catch(() => {});
        }
      })
      .catch(async (error) => {
        state.starting = false;
        await saveState();
        console.error(`[Radio:${guild.id}] Không thể tự phát Lofi sau khi join:`, error);
        if (state.textChannelId) {
          const textChannel = await client.channels.fetch(state.textChannelId).catch(() => null);
          if (textChannel?.isTextBased()) {
            await textChannel.send(`⚠️ Đã vào room nhưng chưa phát được Lofi: ${error.message}`).catch(() => {});
          }
        }
      });
  }

  return response;
}

async function handleLeave(target) {
  const state = stateFor(target.guild.id);
  const userId = target.user?.id || target.author?.id;
  if (!state.channelId) throw new Error('Bot hiện không ở trong phòng thoại.');
  if (state.invitedByUserId !== userId) {
    throw new Error('Chỉ người đã mời bot vào phòng hiện tại mới có thể dùng lệnh này.');
  }
  const player = shoukaku.players.get(target.guild.id);
  if (player) await shoukaku.leaveVoiceChannel(target.guild.id);
  state.queue = [];
  state.current = null;
  state.playing = false;
  state.mode = 'queue';
  state.station = null;
  state.stay247 = false;
  state.channelId = null;
  state.invitedByUserId = null;
  await saveState();
  return reply(target, '👋 Bot đã rời phòng thoại.');
}

function queueDashboard(state, requestedPage = 0) {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(state.queue.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const current = state.current
    ? `▶️ **Đang phát**\n**${state.current.title}**\n\`${duration(state.current.duration)}\``
    : '⏹️ Chưa có bài đang phát';
  const tracks = state.queue.slice(page * pageSize, (page + 1) * pageSize).map((track, index) =>
    `**${page * pageSize + index + 1}.** ${track.title} \`${duration(track.duration)}\``
  );
  const description = `${current}\n\n${tracks.length ? `**Up next • Trang ${page + 1}/${pageCount}**\n${tracks.join('\n')}` : '_Queue đang trống._'}`;

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('queue_toggle').setLabel('⏯').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue_previous').setLabel('⏮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue_next').setLabel('⏭').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue_refresh').setLabel('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue_clear').setLabel('🗑').setStyle(ButtonStyle.Danger)
  );
  const seek = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('queue_volume_down').setLabel('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue_seek_back').setLabel('↩ 10s').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue_shuffle').setLabel('🔀').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('queue_seek_forward').setLabel('10s ↪').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('queue_volume_up').setLabel('🔊').setStyle(ButtonStyle.Secondary)
  );
  const status = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`queue_page_prev:${page}`).setLabel('‹ Trang trước').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`queue_page_next:${page}`).setLabel('Trang sau ›').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
    new ButtonBuilder().setCustomId('queue_leave').setLabel('Rời phòng').setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [new EmbedBuilder()
      .setColor('#d2a84e')
      .setTitle('🎵 Hàng đợi')
      .setDescription(description)
      .addFields(
        { name: '🔊 Volume', value: `\`${state.volume}%\``, inline: true },
        { name: '📚 Tổng queue', value: `\`${state.queue.length} bài\``, inline: true },
        { name: '🎚️ Chế độ', value: `\`${state.mode}\``, inline: true }
      )
      .setFooter({ text: `Edward Radio • Bảng điều khiển phát nhạc • ${state.queue.length} bài` })
      .setTimestamp()],
    components: [controls, seek, status]
  };
}

async function queueDashboardReply(target) {
  return reply(target, queueDashboard(stateFor(target.guild.id)));
}

async function handleQueueButton(interaction) {
  const state = stateFor(interaction.guild.id);
  if (!state.channelId) {
    return interaction.reply({ content: '❌ Bot hiện chưa ở trong phòng thoại.', ephemeral: true });
  }
  const player = shoukaku.players.get(interaction.guild.id);
  const dashboardOnly = interaction.customId === 'queue_refresh' || interaction.customId.startsWith('queue_page_');
  if (!player && !dashboardOnly) {
    return interaction.reply({ content: '❌ Player chưa sẵn sàng.', ephemeral: true });
  }

  if (interaction.customId.startsWith('queue_page_')) {
    const [action, currentPageValue] = interaction.customId.split(':');
    const currentPage = Number.parseInt(currentPageValue, 10) || 0;
    const nextPage = action === 'queue_page_next' ? currentPage + 1 : currentPage - 1;
    return interaction.update(queueDashboard(state, nextPage));
  }

  switch (interaction.customId) {
    case 'queue_toggle':
      await player.setPaused(!player.paused);
      break;
    case 'queue_previous':
      if (state.current?.encoded) await playEncoded(player, state.current.encoded, state.volume);
      break;
    case 'queue_next':
      await player.stopTrack();
      break;
    case 'queue_volume_down':
      state.volume = Math.max(1, state.volume - 10);
      await player.setGlobalVolume(state.volume);
      await saveState();
      break;
    case 'queue_volume_up':
      state.volume = Math.min(100, state.volume + 10);
      await player.setGlobalVolume(state.volume);
      await saveState();
      break;
    case 'queue_seek_back':
      await player.seekTo(Math.max(0, player.position - 10_000));
      break;
    case 'queue_seek_forward':
      await player.seekTo(player.position + 10_000);
      break;
    case 'queue_shuffle':
      for (let index = state.queue.length - 1; index > 0; index -= 1) {
        const random = Math.floor(Math.random() * (index + 1));
        [state.queue[index], state.queue[random]] = [state.queue[random], state.queue[index]];
      }
      await saveState();
      break;
    case 'queue_clear':
      state.queue = [];
      await saveState();
      break;
    case 'queue_leave':
      if (state.invitedByUserId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Chỉ người đã mời bot mới có thể rời phòng.', ephemeral: true });
      }
      await handleLeave(interaction);
      return;
    case 'queue_refresh':
      break;
    default:
      return;
  }

  return interaction.update(queueDashboard(state));
}

function commandBuilders() {
  return [
    new SlashCommandBuilder().setName('play').setDescription('Phát bài hát, playlist, Spotify hoặc radio')
      .addStringOption((option) => option.setName('mode').setDescription('Chế độ phát; mặc định queue').setRequired(false)
        .addChoices(
          { name: 'Queue - bài hát/playlist/Spotify', value: 'queue' },
          { name: 'Station - radio 24/7', value: 'station' }
        ))
      .addStringOption((option) => option.setName('query').setDescription('Tên bài hát, URL YouTube hoặc Spotify').setRequired(false))
      .addStringOption((option) => option.setName('station').setDescription('Trạm radio').setRequired(false)
        .addChoices(
          { name: 'Lofi Hip Hop', value: 'lofi' },
          { name: 'Chillsynth', value: 'chillsynth' },
          { name: 'Smooth Jazz', value: 'jazz' },
          { name: 'Peaceful Piano', value: 'piano' }
        )),
    new SlashCommandBuilder().setName('join').setDescription('Đưa bot vào phòng thoại')
      .addChannelOption((option) => option.setName('room').setDescription('Phòng thoại đích; bỏ trống để dùng phòng hiện tại').setRequired(false)),
    new SlashCommandBuilder().setName('leave').setDescription('Đưa bot rời phòng; chỉ người đã mời bot mới dùng được'),
    new SlashCommandBuilder().setName('shuffle').setDescription('Tráo hàng đợi'),
    new SlashCommandBuilder().setName('skip').setDescription('Bỏ qua bài hiện tại'),
    new SlashCommandBuilder().setName('queue').setDescription('Xem hàng đợi'),
    new SlashCommandBuilder().setName('deleteall').setDescription('Xóa toàn bộ bài đang chờ trong hàng đợi'),
    new SlashCommandBuilder().setName('delete').setDescription('Xóa bài theo vị trí trong hàng đợi')
      .addIntegerOption((option) => option.setName('position').setDescription('Vị trí bài trong queue, bắt đầu từ 1').setMinValue(1).setRequired(true)),
    new SlashCommandBuilder().setName('total').setDescription('Xem tổng thời lượng'),
    new SlashCommandBuilder().setName('volume').setDescription('Chỉnh âm lượng')
      .addIntegerOption((option) => option.setName('value').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)),
    new SlashCommandBuilder().setName('247').setDescription('Bật/tắt treo phòng 24/7'),
    new SlashCommandBuilder().setName('stop').setDescription('Dừng và rời phòng')
  ].map((command) => command.toJSON());
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = process.env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
  await rest.put(route, { body: commandBuilders() });
}

async function reply(target, content) {
  if (target.replied || target.deferred) return target.editReply(content);
  return target.reply(content);
}

async function handlePlay(target, query, mode = 'queue') {
  const guild = target.guild;
  const channel = voiceChannel(target);
  const state = stateFor(guild.id);
  state.textChannelId = target.channel?.id || state.textChannelId;
  if (mode === 'station') {
    const radioKey = query?.toLowerCase();
    if (!RADIO_STATIONS[radioKey]) {
      throw new Error('Chọn một station: lofi, chillsynth, jazz hoặc piano.');
    }
    await startRadio(guild, radioKey, channel.id);
    return reply(target, `📻 Đang phát **${RADIO_STATIONS[radioKey].name}**.`);
  }
  if (!query?.trim()) throw new Error('Nhập tên bài hát hoặc URL để thêm vào queue.');

  const result = await resolveRequest(query);
  if (!result.tracks.length) throw new Error('Không có bài hát hợp lệ trong yêu cầu.');
  if (state.queue.length + result.tracks.length > MAX_QUEUE_SIZE) {
    throw new Error(`Hàng đợi tối đa ${MAX_QUEUE_SIZE} bài.`);
  }
  for (const track of result.tracks) track.requester = target.user?.tag || target.author?.tag || 'Unknown';
  const player = await ensurePlayer(guild, channel.id);
  const replacingRadio = state.mode === 'radio' && state.playing;
  state.mode = 'queue';
  state.station = null;
  state.queue.push(...result.tracks);
  if (replacingRadio) {
    state.playing = false;
    await player.stopTrack();
  }
  const lavalinkHasTrack = Boolean(player.track);
  if (!lavalinkHasTrack || !state.playing) await playNext(guild.id);
  await saveState();
  const addedNames = result.tracks.slice(0, 10).map((track) => `• ${track.title}`).join('\n');
  const skippedText = result.skipped?.length
    ? `\n⚠️ Bỏ qua ${result.skipped.length} bài không resolve được.`
    : '';
  return reply(target, `✅ Đã thêm **${result.tracks.length}** bài vào hàng đợi:\n${addedNames}${skippedText}\nTổng: **${duration(totalDuration(state))}**.`);
}

async function handleCommand(target, command, args) {
  const state = stateFor(target.guild.id);
  state.textChannelId = target.channel?.id || state.textChannelId;
  if (command === 'play' || command === 'p') return handlePlay(target, args.join(' '), 'queue');
  if (command === 'join' || command === 'j') return handleJoin(target);
  if (command === 'leave' || command === 'l') return handleLeave(target);
  if (command === 'shuffle') {
    for (let index = state.queue.length - 1; index > 0; index -= 1) {
      const random = Math.floor(Math.random() * (index + 1));
      [state.queue[index], state.queue[random]] = [state.queue[random], state.queue[index]];
    }
    await saveState();
    return reply(target, `🔀 Đã tráo **${state.queue.length}** bài.`);
  }
  if (command === 'skip') {
    const player = shoukaku.players.get(target.guild.id);
    if (!player) throw new Error('Bot chưa phát nhạc.');
    await player.stopTrack();
    return reply(target, '⏭️ Đã bỏ qua bài hiện tại.');
  }
  if (command === 'queue') {
    return queueDashboardReply(target);
  }
  if (command === 'deleteall') {
    const removed = state.queue.length;
    state.queue = [];
    await saveState();
    return reply(target, removed
      ? `🗑️ Đã xóa **${removed}** bài đang chờ. Bài hiện tại vẫn được phát.`
      : 'Hàng đợi đang trống.');
  }
  if (command === 'delete') {
    const position = Number.parseInt(args[0], 10);
    if (!Number.isInteger(position) || position < 1 || position > state.queue.length) {
      throw new Error(`Vị trí phải từ 1 đến ${state.queue.length}.`);
    }
    const [removed] = state.queue.splice(position - 1, 1);
    await saveState();
    return reply(target, `🗑️ Đã xóa bài số **${position}**: **${removed.title}**.`);
  }
  if (command === 'total') return reply(target, `⏱️ Tổng thời lượng: **${duration(totalDuration(state))}**.`);
  if (command === 'volume') {
    const value = Number.parseInt(args[0], 10);
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Âm lượng phải từ 1 đến 100.');
    state.volume = value;
    const player = shoukaku.players.get(target.guild.id);
    if (player) await player.setGlobalVolume(value);
    await saveState();
    return reply(target, `🔊 Âm lượng: **${value}%**.`);
  }
  if (command === '247') {
    state.stay247 = !state.stay247;
    await saveState();
    return reply(target, `♾️ Chế độ treo phòng: **${state.stay247 ? 'BẬT' : 'TẮT'}**.`);
  }
  if (command === 'stop') return handleLeave(target);
  throw new Error('Lệnh không hợp lệ.');
}

shoukaku.on('error', (name, error) => {
  console.error(`[Lavalink:${name}] ${error?.stack || error?.message || error}`);
});
shoukaku.on('disconnect', (name, count) => console.warn(`[Lavalink:${name}] Ngắt kết nối (${count}).`));
shoukaku.on('ready', (name) => console.log(`[Lavalink:${name}] Sẵn sàng; YouTube OAuth do Lavalink quản lý.`));
shoukaku.on('debug', (message) => console.debug(`[Lavalink] ${message}`));

client.on('clientReady', async () => {
  client.user.setActivity('Edward ϟ Radio', { type: ActivityType.Listening });
  console.log(`Đăng nhập Discord: ${client.user.tag}`);
  try {
    await registerCommands();
    console.log('Đã đăng ký slash commands.');
  } catch (error) {
    console.error('[Commands] Đăng ký thất bại:', error.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return;
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith('queue_')) return;
    try {
      await handleQueueButton(interaction);
    } catch (error) {
      console.error('[Queue Button]', error);
      const content = `❌ ${error.message || 'Không thể thực hiện điều khiển.'}`;
      if (interaction.replied || interaction.deferred) await interaction.editReply(content);
      else await interaction.reply({ content, ephemeral: true });
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    await interaction.deferReply();
    const args = interaction.commandName === 'play'
      ? [interaction.options.getString('query') || interaction.options.getString('station')]
      : interaction.commandName === 'volume'
        ? [String(interaction.options.getInteger('value', true))]
        : interaction.commandName === 'delete'
          ? [String(interaction.options.getInteger('position', true))]
        : [];
    if (interaction.commandName === 'play') {
      await handlePlay(
        interaction,
        args[0],
        interaction.options.getString('mode') || 'queue'
      );
    } else if (interaction.commandName === 'join') {
      await handleJoin(interaction, interaction.options.getChannel('room'));
    } else if (interaction.commandName === 'leave') {
      await handleLeave(interaction);
    } else {
      await handleCommand(interaction, interaction.commandName, args);
    }
  } catch (error) {
    console.error('[Interaction]', error);
    await reply(interaction, `❌ ${error.message || 'Đã xảy ra lỗi.'}`);
  }
});

function messageVoiceChannel(message, args) {
  const mentioned = message.mentions.channels.first();
  if (mentioned?.isVoiceBased()) return mentioned;
  const id = args[0]?.match(/^<#(\d+)>$/)?.[1];
  if (id) {
    const channel = message.guild.channels.cache.get(id);
    if (channel?.isVoiceBased()) return channel;
  }
  const name = args.join(' ').trim().toLowerCase();
  if (name) {
    return message.guild.channels.cache.find((channel) =>
      channel.isVoiceBased() && channel.name.toLowerCase() === name
    ) || null;
  }
  return null;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.toLowerCase().startsWith(PREFIX)) return;
  const parts = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();
  const aliases = {
    edp: 'play',
    edj: 'join',
    edl: 'leave',
    edsf: 'shuffle',
    eds: 'skip',
    edq: 'queue',
    eddlall: 'deleteall',
    eddl: 'delete',
    edt: 'total',
    edvol: 'volume',
    ed247: '247',
    edstop: 'stop'
  };
  const normalized = aliases[`${PREFIX}${command}`] || aliases[command] || command;
  let pendingReply = null;
  try {
    if (normalized === 'join') {
      pendingReply = await message.reply('⏳ Đang kết nối Lavalink và vào phòng thoại...');
      await handleJoin(message, messageVoiceChannel(message, parts), pendingReply);
    } else {
      await handleCommand(message, normalized, parts);
    }
  } catch (error) {
    console.error('[Prefix]', error);
    const content = `❌ ${error.message || 'Đã xảy ra lỗi.'}`;
    if (pendingReply) await pendingReply.edit(content).catch(() => message.reply(content));
    else await message.reply(content);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.member?.id === client.user?.id) {
    const state = stateFor(newState.guild.id);
    state.channelId = newState.channelId;
    await saveState();
    console.log(`[Voice:${newState.guild.id}] Bot chuyển sang: ${newState.channelId || 'không ở phòng thoại'}`);
    return;
  }
  if (!oldState.channelId || newState.channelId || oldState.channelId !== stateFor(oldState.guild.id).channelId) return;
  const state = stateFor(oldState.guild.id);
  if (state.stay247 && oldState.channel?.members.filter((member) => !member.user.bot).size === 0) {
    const player = shoukaku.players.get(oldState.guild.id);
    if (!player) {
      try {
        await ensurePlayer(oldState.guild, state.channelId);
        if (state.current?.encoded) await playNext(oldState.guild.id);
      } catch (error) {
        console.error('[24/7] Không thể nối lại:', error.message);
      }
    }
  }
});

process.on('unhandledRejection', (error) => console.error('[Unhandled Rejection]', error));
process.on('uncaughtException', (error) => console.error('[Uncaught Exception]', error));

(async () => {
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
    throw new Error('Thiếu DISCORD_TOKEN hoặc DISCORD_CLIENT_ID trong .env.');
  }
  console.log(`[Config] Spotify OAuth: ${process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET ? 'đã cấu hình' : 'chưa cấu hình'}; Lavalink: ${nodes[0].url}`);
  await loadState();
  await client.login(process.env.DISCORD_TOKEN);
})().catch((error) => {
  console.error('[Startup]', error);
  process.exitCode = 1;
});
