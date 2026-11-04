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
  SlashCommandBuilder
} = require('discord.js');
const { Connectors, Shoukaku } = require('shoukaku');

const PREFIX = process.env.PREFIX || 'ed';
const STATE_FILE = path.resolve(process.env.STATE_FILE || 'state.json');
const MAX_QUEUE_SIZE = Number.parseInt(process.env.MAX_QUEUE_SIZE || '500', 10);
const DEFAULT_VOLUME = 70;

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
  url: `${process.env.LAVALINK_HOST || '127.0.0.1'}:${process.env.LAVALINK_PORT || '2333'}`,
  auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
  secure: process.env.LAVALINK_SECURE === 'true'
}];
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
  moveOnDisconnect: false,
  resume: true,
  resumeTimeout: 30,
  resumeByLibrary: true,
  reconnectTries: 10,
  restTimeout: 10_000
});

const guildStates = new Map();
let spotifyToken = null;
let spotifyTokenExpiresAt = 0;

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
      playing: false
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
  return spotifyToken;
}

async function spotifyRequest(endpoint) {
  const response = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${await getSpotifyToken()}` }
  });
  if (!response.ok) throw new Error(`Spotify API thất bại (${response.status}).`);
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
  const node = shoukaku.getIdealNode();
  if (!node) throw new Error('Chưa kết nối được Lavalink.');
  const result = await node.rest.resolve(query);
  if (!result) throw new Error('Lavalink không trả về kết quả.');
  if (result.loadType === 'empty') throw new Error('Lavalink không tìm thấy kết quả.');
  if (result.loadType === 'error') {
    throw new Error(`Lavalink resolve lỗi: ${result.data?.message || 'nguồn không khả dụng'}`);
  }
  if (result.loadType === 'search' || result.loadType === 'track') {
    const track = result.loadType === 'track' ? result.data : result.data?.tracks?.[0];
    if (!track) throw new Error('Không tìm thấy bài hát.');
    return [track];
  }
  if (result.loadType === 'playlist') return result.data.tracks || [];
  throw new Error(`Lavalink trả về trạng thái không hỗ trợ: ${result.loadType}.`);
}

async function resolveRequest(input) {
  if (isSpotifyUrl(input)) {
    const reference = spotifyReference(input);
    const spotifyItems = await spotifyTracks(reference);
    const resolved = [];
    for (const item of spotifyItems) {
      const tracks = await resolveLavalink(`ytsearch:${item.query}`);
      if (tracks[0]) {
        resolved.push({
          encoded: tracks[0].encoded,
          title: item.title,
          uri: tracks[0].info?.uri || null,
          duration: item.duration || tracks[0].info?.length || 0,
          artworkUrl: item.artworkUrl,
          requester: null
        });
      }
    }
    return { tracks: resolved, playlistName: reference.type === 'track' ? null : 'Spotify collection' };
  }

  const tracks = await resolveLavalink(isUrl(input) ? input : `ytsearch:${input}`);
  return {
    tracks: tracks.map((track) => ({
      encoded: track.encoded,
      title: track.info?.author ? `${track.info.author} - ${track.info.title}` : track.info?.title || 'Unknown track',
      uri: track.info?.uri || null,
      duration: track.info?.length || 0,
      artworkUrl: track.info?.artworkUrl || null,
      requester: null
    })),
    playlistName: tracks.length > 1 ? 'Playlist' : null
  };
}

async function ensurePlayer(guild, channelId) {
  const state = stateFor(guild.id);
  if (state.channelId && state.channelId !== channelId) {
    throw new Error('Bot đang ở một phòng thoại khác trong server này.');
  }
  state.channelId = channelId;
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
    stateFor(guild.id).playing = true;
    await saveState();
  });
  player.on('end', async () => {
    if (stateFor(guild.id).mode !== 'radio') await playNext(guild.id);
  });
  player.on('exception', (error) => console.error(`[Player:${guild.id}]`, error));
  player.on('stuck', (threshold) => console.warn(`[Player:${guild.id}] Kẹt sau ${threshold}ms.`));
  player.on('closed', (code, reason) => console.warn(`[Player:${guild.id}] Đóng (${code}): ${reason || 'không rõ lý do'}`));
  return player;
}

async function playNext(guildId) {
  const state = stateFor(guildId);
  const player = shoukaku.players.get(guildId);
  if (!player) return;
  if (state.mode === 'radio' && state.station) {
    await player.playTrack({ track: { encoded: state.station.encoded }, volume: state.volume });
    state.current = state.station;
    state.playing = true;
    await saveState();
    return;
  }
  const next = state.queue.shift();
  if (!next) {
    state.current = null;
    state.playing = false;
    await saveState();
    return;
  }
  state.current = next;
  state.playing = true;
  await player.playTrack({ track: { encoded: next.encoded }, volume: state.volume });
  await saveState();
}

async function startRadio(guild, stationKey) {
  const station = RADIO_STATIONS[stationKey];
  if (!station?.url) throw new Error(`Radio "${stationKey}" chưa được cấu hình URL.`);
  const player = await ensurePlayer(guild, stateFor(guild.id).channelId);
  const tracks = await resolveLavalink(station.url);
  const state = stateFor(guild.id);
  state.mode = 'radio';
  state.station = {
    encoded: tracks[0].encoded,
    title: station.name,
    duration: tracks[0].info?.length || 0,
    artworkUrl: tracks[0].info?.artworkUrl || null
  };
  state.queue = [];
  await player.playTrack({ track: { encoded: state.station.encoded }, volume: state.volume });
  state.current = state.station;
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
      guildStates.set(data.guildId, { ...stateFor(data.guildId), ...data });
      return;
    }
    for (const [guildId, state] of Object.entries(data)) {
      if (state && typeof state === 'object' && state.guildId) {
        guildStates.set(guildId, { ...stateFor(guildId), ...state });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[State] Không thể đọc state.json:', error.message);
  }
}

function voiceChannel(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error('Bạn phải vào phòng thoại trước.');
  return channel;
}

function commandBuilders() {
  return [
    new SlashCommandBuilder().setName('play').setDescription('Phát bài hát, playlist, Spotify hoặc radio')
      .addStringOption((option) => option.setName('query').setDescription('Tên, URL hoặc lofi/chillsynth/jazz/piano').setRequired(true)),
    new SlashCommandBuilder().setName('shuffle').setDescription('Tráo hàng đợi'),
    new SlashCommandBuilder().setName('skip').setDescription('Bỏ qua bài hiện tại'),
    new SlashCommandBuilder().setName('queue').setDescription('Xem hàng đợi'),
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

async function handlePlay(target, query) {
  const guild = target.guild;
  const channel = voiceChannel(target);
  const state = stateFor(guild.id);
  await ensurePlayer(guild, channel.id);
  const radioKey = query.toLowerCase();
  if (RADIO_STATIONS[radioKey]) {
    await startRadio(guild, radioKey);
    return reply(target, `📻 Đang phát **${RADIO_STATIONS[radioKey].name}**.`);
  }

  const result = await resolveRequest(query);
  if (!result.tracks.length) throw new Error('Không có bài hát hợp lệ trong yêu cầu.');
  if (state.queue.length + result.tracks.length > MAX_QUEUE_SIZE) {
    throw new Error(`Hàng đợi tối đa ${MAX_QUEUE_SIZE} bài.`);
  }
  for (const track of result.tracks) track.requester = target.user?.tag || target.author?.tag || 'Unknown';
  state.mode = 'queue';
  state.station = null;
  state.queue.push(...result.tracks);
  const shouldStart = !state.playing;
  if (shouldStart) await playNext(guild.id);
  await saveState();
  return reply(target, `✅ Đã thêm **${result.tracks.length}** bài vào hàng đợi. Tổng: **${duration(totalDuration(state))}**.`);
}

async function handleCommand(target, command, args) {
  const state = stateFor(target.guild.id);
  if (command === 'play' || command === 'p') return handlePlay(target, args.join(' '));
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
    const lines = state.queue.slice(0, 15).map((track, index) => `${index + 1}. ${track.title} (${duration(track.duration)})`);
    return reply(target, lines.length ? `🎶 **Hàng đợi**\n${lines.join('\n')}` : 'Hàng đợi đang trống.');
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
  if (command === 'stop') {
    state.queue = [];
    state.current = null;
    state.playing = false;
    state.mode = 'queue';
    state.station = null;
    state.stay247 = false;
    const player = shoukaku.players.get(target.guild.id);
    if (player) await shoukaku.leaveVoiceChannel(target.guild.id);
    state.channelId = null;
    await saveState();
    return reply(target, '⏹️ Đã dừng nhạc và rời phòng.');
  }
  throw new Error('Lệnh không hợp lệ.');
}

shoukaku.on('error', (name, error) => {
  console.error(`[Lavalink:${name}] ${error?.stack || error?.message || error}`);
});
shoukaku.on('disconnect', (name, count) => console.warn(`[Lavalink:${name}] Ngắt kết nối (${count}).`));
shoukaku.on('ready', (name) => console.log(`[Lavalink:${name}] Sẵn sàng.`));
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
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  try {
    await interaction.deferReply();
    const args = interaction.commandName === 'play'
      ? [interaction.options.getString('query', true)]
      : interaction.commandName === 'volume'
        ? [String(interaction.options.getInteger('value', true))]
        : [];
    await handleCommand(interaction, interaction.commandName, args);
  } catch (error) {
    console.error('[Interaction]', error);
    await reply(interaction, `❌ ${error.message || 'Đã xảy ra lỗi.'}`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.toLowerCase().startsWith(PREFIX)) return;
  const parts = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();
  const aliases = { edp: 'play', edsf: 'shuffle', eds: 'skip', edq: 'queue', edt: 'total', edvol: 'volume', ed247: '247', edstop: 'stop' };
  const normalized = aliases[`${PREFIX}${command}`] || aliases[command] || command;
  try {
    await handleCommand(message, normalized, parts);
  } catch (error) {
    console.error('[Prefix]', error);
    await message.reply(`❌ ${error.message || 'Đã xảy ra lỗi.'}`);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
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
  await loadState();
  await client.login(process.env.DISCORD_TOKEN);
})().catch((error) => {
  console.error('[Startup]', error);
  process.exitCode = 1;
});
