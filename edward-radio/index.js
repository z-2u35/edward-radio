require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

const spotifyScraper = require('spotify-url-info')(global.fetch);

process.on('unhandledRejection', error => {
    console.error('[Unhandled Rejection]:', error);
});

process.on('uncaughtException', error => {
    console.error('[Uncaught Exception]:', error);
});

const {
    Client,
    GatewayIntentBits,
    ActivityType,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    NoSubscriberBehavior,
    getVoiceConnection
} = require('@discordjs/voice');
const youtubedl = require('youtube-dl-exec');

// ============================================================================
// 1. CẤU HÌNH COOKIES CHO YT-DLP (VƯỢT CHẶN IP TRÊN RENDER)
// ============================================================================
function getCookiePath() {
    const renderSecretPath = '/etc/secrets/cookies.txt';
    const localCookiePath = path.join(__dirname, 'cookies.txt');
    const writableCookiePath = path.join('/tmp', 'yt_cookies.txt');

    try {
        if (fs.existsSync(renderSecretPath)) {
            fs.copyFileSync(renderSecretPath, writableCookiePath);
            return writableCookiePath;
        }
        if (fs.existsSync(localCookiePath)) {
            return localCookiePath;
        }
    } catch (e) {
        console.error('[Cookie Init Error]:', e.message);
    }
    return null;
}

function buildYtDlpOptions(extraOptions = {}) {
    const options = {
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        ...extraOptions
    };

    const cookieFile = getCookiePath();
    if (cookieFile) {
        options.cookies = cookieFile;
    } else {
        options.extractorArgs = 'youtube:player_client=android,web';
    }

    return options;
}

// ============================================================================
// 2. OFFICIAL SPOTIFY WEB API & SCRAPER FALLBACK
// ============================================================================
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyAccessToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    if (spotifyToken && Date.now() < spotifyTokenExpiry) {
        return spotifyToken;
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    if (!res.ok) return null;

    const data = await res.json();
    spotifyToken = data.access_token;
    spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return spotifyToken;
}

async function resolveSpotifyUrl(url) {
    const match = url.match(/spotify\.com\/(?:intl-[a-z]+\/)?(track|playlist|album)\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error('Link Spotify không hợp lệ.');

    const [, type, id] = match;
    const token = await getSpotifyAccessToken();

    if (token) {
        const headers = { 'Authorization': `Bearer ${token}` };

        if (type === 'track') {
            const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers });
            const track = await res.json();
            const artists = track.artists.map(a => a.name).join(', ');
            return {
                isPlaylist: false,
                title: `${artists} - ${track.name}`,
                searchQuery: `${track.name} ${artists} Official Audio`,
                duration: track.duration_ms || 0
            };
        }

        if (type === 'playlist' || type === 'album') {
            const endpoint = type === 'playlist'
                ? `https://api.spotify.com/v1/playlists/${id}`
                : `https://api.spotify.com/v1/albums/${id}`;

            const res = await fetch(endpoint, { headers });
            const data = await res.json();

            let trackList = [];
            let totalDurationMs = 0;
            let items = data.tracks.items || [];

            for (const item of items) {
                const track = item.track || item;
                if (track && track.name) {
                    const artists = track.artists ? track.artists.map(a => a.name).join(', ') : '';
                    const duration = track.duration_ms || 0;
                    totalDurationMs += duration;

                    trackList.push({
                        title: artists ? `${artists} - ${track.name}` : track.name,
                        url: `ytsearch1:${track.name} ${artists} Official Audio`,
                        duration: duration,
                        isSearchQuery: true
                    });
                }
            }

            return {
                isPlaylist: true,
                title: data.name || 'Spotify Playlist',
                totalTracks: trackList.length,
                totalDurationMs: totalDurationMs,
                tracks: trackList
            };
        }
    }

    // Dự phòng qua scraper nếu chưa cấu hình API Key
    if (type === 'playlist' || type === 'album') {
        const playlistData = await spotifyScraper.getData(url);
        const rawTracks = playlistData.trackList || playlistData.tracks?.items || [];
        let trackList = [];
        let totalDurationMs = 0;

        for (const item of rawTracks) {
            const track = item.track || item;
            if (track) {
                const trackName = track.title || track.name;
                let artistName = track.subtitle ? track.subtitle.replace(/\u00a0/g, ' ') : '';
                if (!artistName && Array.isArray(track.artists)) {
                    artistName = track.artists.map(a => a.name || a).join(', ');
                }
                const durationMs = track.duration || track.duration_ms || 0;
                totalDurationMs += durationMs;

                if (trackName) {
                    trackList.push({
                        title: artistName ? `${artistName} - ${trackName}` : trackName,
                        url: `ytsearch1:${trackName} ${artistName} Official Audio`,
                        duration: durationMs,
                        isSearchQuery: true
                    });
                }
            }
        }
        return {
            isPlaylist: true,
            title: playlistData.title || playlistData.name || 'Spotify Playlist',
            totalTracks: trackList.length,
            totalDurationMs: totalDurationMs,
            tracks: trackList
        };
    } else {
        const preview = await spotifyScraper.getPreview(url);
        return {
            isPlaylist: false,
            title: preview.artist ? `${preview.artist} - ${preview.title}` : preview.title,
            searchQuery: `${preview.title} ${preview.artist || ''} Official Audio`,
            duration: 0
        };
    }
}

// ============================================================================
// 3. LOGIC XỬ LÝ ÂM THANH & BOT DISCORD
// ============================================================================
const STATIONS = {
    lofi: { name: '☕ Lofi Hip Hop Beats', url: 'https://streams.ilovemusic.de/iloveradio17.mp3', desc: 'Nhạc Lofi thư giãn, học bài & làm việc' },
    chill: { name: '🌙 Chillsynth / Nightwave', url: 'https://radio.plaza.one/mp3', desc: 'Giai điệu Synthwave & Aesthetic ban đêm' },
    jazz: { name: '🎷 Smooth Jazz 24/7', url: 'https://jazz-wr04.ice.infomaniak.ch/jazz-wr04-128.mp3', desc: 'Nhạc Jazz nhẹ nhàng, sang trọng' },
    piano: { name: '🎹 Peaceful Piano', url: 'https://stream.zeno.fm/f3wvbbqmdg8uv', desc: 'Độc tấu Piano êm dịu, dễ ngủ' }
};

const STATE_FILE = path.join(__dirname, 'state.json');
const PLAYLISTS_FILE = path.join(__dirname, 'playlists.json');

let botState = {
    guildId: null,
    channelId: null,
    station: 'lofi',
    volume: 50,
    stay247: true,
    isPlaying: false,
    mode: 'radio'
};

let queue = [];
let currentTrack = null;
let userPlaylists = {};

function loadData() {
    if (fs.existsSync(STATE_FILE)) {
        try { botState = { ...botState, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) {}
    }
    if (fs.existsSync(PLAYLISTS_FILE)) {
        try { userPlaylists = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch (e) {}
    }
}

function saveData() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(userPlaylists, null, 2));
}

loadData();

let currentResource = null;
let ffmpegProcess = null;
let currentHttpReq = null;
let retryTimeout = null;

const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

function cleanupStreams() {
    if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
    if (currentHttpReq) { try { currentHttpReq.destroy(); } catch (e) {} currentHttpReq = null; }
    if (ffmpegProcess) { try { ffmpegProcess.kill('SIGKILL'); } catch (e) {} ffmpegProcess = null; }
}

function playRadioStream() {
    cleanupStreams();
    const station = STATIONS[botState.station] || STATIONS.lofi;
    console.log(`[Edward ϟ Radio] Đang phát đài: ${station.name}`);

    const clientProto = station.url.startsWith('https') ? https : http;
    const req = clientProto.get(station.url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        currentHttpReq = req;
        ffmpegProcess = spawn(ffmpegPath, ['-i', 'pipe:0', '-analyzeduration', '0', '-loglevel', 'warning', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { windowsHide: true });
        res.pipe(ffmpegProcess.stdin);

        currentResource = createAudioResource(ffmpegProcess.stdout, { inputType: StreamType.Raw, inlineVolume: true });
        currentResource.volume.setVolume(botState.volume / 100);
        player.play(currentResource);
        botState.isPlaying = true;
        botState.mode = 'radio';
        saveData();

        if (client.user) client.user.setActivity(`${station.name} | edp`, { type: ActivityType.Listening });
    });

    req.on('error', () => {
        if (botState.isPlaying && botState.mode === 'radio') {
            retryTimeout = setTimeout(() => playRadioStream(), 6000);
        }
    });
}

async function resolveTrackInfo(query) {
    let searchTarget = query;
    let customTitle = null;
    let customDuration = 0;

    if (query.includes('spotify.com')) {
        const spData = await resolveSpotifyUrl(query);
        if (spData.isPlaylist) return spData;
        searchTarget = `ytsearch1:${spData.searchQuery}`;
        customTitle = spData.title;
        customDuration = spData.duration;
    } else if (!query.startsWith('http://') && !query.startsWith('https://')) {
        searchTarget = `ytsearch1:${query}`;
    }

    try {
        const searchRes = await youtubedl(searchTarget, buildYtDlpOptions({ dumpJson: true }));
        return {
            isPlaylist: false,
            title: customTitle || searchRes.title || 'Bài hát không tên',
            url: searchRes.webpage_url || searchRes.url || query,
            duration: customDuration || (searchRes.duration || 0) * 1000,
            isSearchQuery: false
        };
    } catch (err) {
        console.error('[Resolve Track Error]:', err.message);
        throw new Error('Không thể tìm thấy bài hát. Vui lòng kiểm tra lại cookies.txt trên Render.');
    }
}

async function playTrack(track) {
    cleanupStreams();
    currentTrack = track;
    botState.mode = 'queue';

    let targetUrl = track.url;
    if (track.isSearchQuery) {
        try {
            console.log(`[Edward ϟ Radio] Đang tìm kiếm chính xác: ${track.title}`);
            const searchRes = await youtubedl(track.url, buildYtDlpOptions({ dumpJson: true }));
            targetUrl = searchRes.webpage_url || searchRes.url;
            if (!track.duration && searchRes.duration) {
                track.duration = searchRes.duration * 1000;
            }
        } catch (e) {
            console.error('[Playlist Track Resolve Error]:', e.message);
            return playNextInQueue();
        }
    }

    console.log(`[Edward ϟ Radio] Đang phát bài hát: ${track.title}`);

    try {
        const streamUrl = await youtubedl(targetUrl, buildYtDlpOptions({
            getUrl: true,
            format: 'bestaudio/best'
        }));

        const finalUrl = typeof streamUrl === 'string' ? streamUrl.trim().split('\n')[0] : targetUrl;

        ffmpegProcess = spawn(ffmpegPath, [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-i', finalUrl,
            '-vn',
            '-analyzeduration', '0',
            '-loglevel', 'warning',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1'
        ], { windowsHide: true });

        currentResource = createAudioResource(ffmpegProcess.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });

        currentResource.volume.setVolume(botState.volume / 100);
        player.play(currentResource);
        botState.isPlaying = true;
        saveData();

        if (client.user) {
            client.user.setActivity(track.title, { type: ActivityType.Listening });
        }
    } catch (err) {
        console.error('[Stream Error]:', err.message);
        playNextInQueue();
    }
}

function playNextInQueue() {
    if (queue.length > 0) {
        const next = queue.shift();
        playTrack(next);
    } else {
        botState.mode = 'idle';
        botState.isPlaying = false;
        currentTrack = null;
        cleanupStreams();
        player.stop();
        if (client.user) {
            client.user.setActivity('edp để phát nhạc', { type: ActivityType.Listening });
        }
    }
}

player.on(AudioPlayerStatus.Idle, () => {
    if (botState.mode === 'queue') {
        playNextInQueue();
    } else if (botState.mode === 'radio' && botState.isPlaying) {
        retryTimeout = setTimeout(() => playRadioStream(), 3000);
    }
});

async function connectToVoice(guildId, channelId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return false;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return false;

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
    });

    try { await entersState(connection, VoiceConnectionStatus.Ready, 15_000); } catch (e) {}

    connection.subscribe(player);
    botState.guildId = guildId;
    botState.channelId = channelId;

    if (botState.mode === 'radio' && !botState.isPlaying) {
        playRadioStream();
    }
    return true;
}

function formatDuration(ms) {
    if (!ms || isNaN(ms) || ms <= 0) return 'Đang cập nhật...';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours} giờ ${minutes} phút ${seconds} giây`;
    }
    return `${minutes} phút ${seconds} giây`;
}

async function registerCommands() {
    const stationChoices = Object.entries(STATIONS).map(([key, val]) => ({ name: val.name, value: key }));

    const commands = [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Phát nhạc từ YouTube, Spotify, SoundCloud hoặc Radio')
            .addStringOption(opt => opt.setName('query').setDescription('Tên bài hát hoặc Link Spotify/YouTube').setRequired(false))
            .addStringOption(opt => opt.setName('station').setDescription('Chọn đài Radio phát 24/7').setRequired(false).addChoices(...stationChoices)),
        new SlashCommandBuilder().setName('skip').setDescription('Bỏ qua bài hát hiện tại'),
        new SlashCommandBuilder().setName('queue').setDescription('Xem danh sách hàng đợi'),
        new SlashCommandBuilder().setName('total').setDescription('Xem tổng thời lượng hàng đợi hiện tại'),
        new SlashCommandBuilder().setName('volume').setDescription('Chỉnh âm lượng (1-100)').addIntegerOption(opt => opt.setName('mức').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)),
        new SlashCommandBuilder().setName('247').setDescription('Bật hoặc tắt chế độ treo 24/7'),
        new SlashCommandBuilder().setName('stop').setDescription('Dừng nhạc và rời phòng')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(process.env.GUILD_ID ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID) : Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
}

client.once('clientReady', async () => {
    console.log(`⚡ ${client.user.tag} đã sẵn sàng!`);
    console.log(`🍪 Trạng thái Cookie YouTube: ${getCookiePath() ? 'Đã kích hoạt' : 'Chưa có'}`);
    await registerCommands();
    if (botState.stay247 && botState.guildId && botState.channelId) {
        connectToVoice(botState.guildId, botState.channelId);
    }
});

const PREFIX = 'ed';
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'p' || command === 'play') {
        const userVoice = message.member.voice.channel;
        if (!userVoice) return message.reply('❌ Bạn cần vào một phòng thoại trước!');

        await connectToVoice(message.guild.id, userVoice.id);
        const query = args.join(' ');

        if (!query) {
            botState.mode = 'radio';
            playRadioStream();
            return message.reply(`▶️ Tiếp tục phát đài **${STATIONS[botState.station].name}**.`);
        }

        if (STATIONS[query.toLowerCase()]) {
            botState.station = query.toLowerCase();
            botState.mode = 'radio';
            playRadioStream();
            return message.reply(`📻 Đã chuyển sang đài **${STATIONS[botState.station].name}**.`);
        }

        try {
            message.channel.sendTyping();
            const result = await resolveTrackInfo(query);

            if (result.isPlaylist) {
                const tracksToAdd = result.tracks.map(t => ({
                    title: t.title,
                    url: t.url,
                    duration: t.duration,
                    isSearchQuery: true,
                    requester: message.author.tag
                }));

                queue = [];
                cleanupStreams();
                player.stop();
                queue.push(...tracksToAdd);

                const embed = new EmbedBuilder()
                    .setColor('#1DB954')
                    .setTitle(`🎵 Đã phát Playlist Spotify: ${result.title}`)
                    .setDescription(`📥 Đã nạp và phát ngay **${tracksToAdd.length} bài hát**!`)
                    .addFields(
                        { name: '⏱️ Tổng thời lượng chính xác', value: `\`${formatDuration(result.totalDurationMs)}\``, inline: true }
                    )
                    .setFooter({ text: 'Yêu cầu bởi ' + message.author.tag });

                message.reply({ embeds: [embed] });
                playNextInQueue();
                return;
            }

            const track = { title: result.title, url: result.url, duration: result.duration, isSearchQuery: result.isSearchQuery, requester: message.author.tag };

            if ((botState.mode === 'radio' || botState.mode === 'idle') && !currentTrack && queue.length === 0) {
                playTrack(track);
                return message.reply(`🎶 Đang phát: **${track.title}** (\`${formatDuration(track.duration)}\`)`);
            } else {
                queue.push(track);
                return message.reply(`➕ Đã thêm vào hàng đợi: **${track.title}** (Vị trí #${queue.length})`);
            }
        } catch (e) {
            return message.reply(`❌ ${e.message}`);
        }
    }

    if (command === 't' || command === 'total' || command === 'edt' || command === 'edtotal') {
        let totalMs = currentTrack ? (currentTrack.duration || 0) : 0;
        for (const t of queue) {
            totalMs += (t.duration || 0);
        }

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('⏱️ Tổng thời lượng danh sách phát')
            .setDescription(`• **Tổng số bài:** \`${queue.length + (currentTrack ? 1 : 0)} bài\`\n• **Tổng thời lượng:** \`${formatDuration(totalMs)}\``);

        return message.reply({ embeds: [embed] });
    }

    if (command === 's' || command === 'skip') {
        if (botState.mode !== 'queue') return message.reply('❌ Không có bài hát nào trong hàng đợi!');
        message.reply('⏭️ Đã bỏ qua bài hát hiện tại!');
        playNextInQueue();
    }

    if (command === 'q' || command === 'queue') {
        if (queue.length === 0 && !currentTrack) return message.reply('📭 Hàng đợi đang trống.');
        const list = queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (\`${formatDuration(t.duration)}\`)`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle('🎶 Hàng đợi bài hát')
            .setDescription(`**Đang phát:** ${currentTrack?.title || 'Radio'}\n\n${list}${queue.length > 10 ? `\n... và ${queue.length - 10} bài khác` : ''}`)
            .setColor('#9B59B6');
        return message.reply({ embeds: [embed] });
    }

    if (command === 'vol') {
        const vol = parseInt(args[0]);
        if (isNaN(vol) || vol < 1 || vol > 100) return message.reply('❌ Vui lòng nhập mức âm lượng từ 1 đến 100.');
        botState.volume = vol;
        if (currentResource) currentResource.volume.setVolume(vol / 100);
        saveData();
        return message.reply(`🔉 Đã chỉnh âm lượng thành **${vol}%**.`);
    }

    if (command === '247') {
        botState.stay247 = !botState.stay247;
        saveData();
        return message.reply(botState.stay247 ? '🟢 Đã BẬT 24/7!' : '🔴 Đã TẮT 24/7!');
    }

    if (command === 'stop') {
        botState.isPlaying = false;
        botState.channelId = null;
        botState.mode = 'idle';
        queue = [];
        currentTrack = null;
        saveData();
        cleanupStreams();
        player.stop();
        const conn = getVoiceConnection(message.guild.id);
        if (conn) conn.destroy();
        return message.reply('👋 Đã dừng nhạc!');
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'play') {
        const userVoice = interaction.member.voice.channel;
        if (!userVoice) return interaction.reply({ content: '❌ Bạn phải vào phòng thoại trước!', flags: MessageFlags.Ephemeral });

        const query = interaction.options.getString('query');
        const stationKey = interaction.options.getString('station');

        await interaction.deferReply();
        await connectToVoice(interaction.guild.id, userVoice.id);

        if (stationKey && !query) {
            botState.station = stationKey;
            botState.mode = 'radio';
            playRadioStream();
            return interaction.editReply(`📻 Đã chuyển sang đài **${STATIONS[stationKey].name}**.`);
        }

        if (!query) {
            botState.mode = 'radio';
            playRadioStream();
            return interaction.editReply(`▶️ Tiếp tục phát đài **${STATIONS[botState.station].name}**.`);
        }

        try {
            const result = await resolveTrackInfo(query);

            if (result.isPlaylist) {
                const tracksToAdd = result.tracks.map(t => ({
                    title: t.title,
                    url: t.url,
                    duration: t.duration,
                    isSearchQuery: true,
                    requester: interaction.user.tag
                }));

                queue = [];
                cleanupStreams();
                player.stop();
                queue.push(...tracksToAdd);

                const embed = new EmbedBuilder()
                    .setColor('#1DB954')
                    .setTitle(`🎵 Đã phát Playlist Spotify: ${result.title}`)
                    .setDescription(`📥 Đã nạp và phát ngay **${tracksToAdd.length} bài hát**!`)
                    .addFields(
                        { name: '⏱️ Tổng thời lượng chính xác', value: `\`${formatDuration(result.totalDurationMs)}\``, inline: true }
                    );

                await interaction.editReply({ embeds: [embed] });
                playNextInQueue();
                return;
            }

            const track = { title: result.title, url: result.url, duration: result.duration, isSearchQuery: result.isSearchQuery, requester: interaction.user.tag };

            if ((botState.mode === 'radio' || botState.mode === 'idle') && !currentTrack && queue.length === 0) {
                playTrack(track);
                return interaction.editReply(`🎶 Đang phát: **${track.title}** (\`${formatDuration(track.duration)}\`)`);
            } else {
                queue.push(track);
                return interaction.editReply(`➕ Đã thêm vào hàng đợi: **${track.title}** (Vị trí #${queue.length})`);
            }
        } catch (e) {
            return interaction.editReply(`❌ ${e.message}`);
        }
    }

    if (commandName === 'total') {
        let totalMs = currentTrack ? (currentTrack.duration || 0) : 0;
        for (const t of queue) {
            totalMs += (t.duration || 0);
        }
        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('⏱️ Tổng thời lượng danh sách phát')
            .setDescription(`• **Tổng số bài:** \`${queue.length + (currentTrack ? 1 : 0)} bài\`\n• **Tổng thời lượng:** \`${formatDuration(totalMs)}\``);
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'skip') {
        if (botState.mode !== 'queue') return interaction.reply({ content: '❌ Không có hàng đợi!', flags: MessageFlags.Ephemeral });
        interaction.reply('⏭️ Đã bỏ qua bài hát!');
        playNextInQueue();
    }

    if (commandName === 'queue') {
        if (queue.length === 0 && !currentTrack) return interaction.reply('📭 Hàng đợi đang trống.');
        const list = queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (\`${formatDuration(t.duration)}\`)`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle('🎶 Hàng đợi bài hát')
            .setDescription(`**Đang phát:** ${currentTrack?.title || 'Radio'}\n\n${list}${queue.length > 10 ? `\n... và ${queue.length - 10} bài khác` : ''}`)
            .setColor('#9B59B6');
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'volume') {
        const vol = interaction.options.getInteger('mức');
        botState.volume = vol;
        if (currentResource) currentResource.volume.setVolume(vol / 100);
        saveData();
        return interaction.reply(`🔉 Đã chỉnh âm lượng thành **${vol}%**.`);
    }

    if (commandName === '247') {
        botState.stay247 = !botState.stay247;
        saveData();
        return interaction.reply(botState.stay247 ? '🟢 Đã BẬT 24/7!' : '🔴 Đã TẮT 24/7!');
    }

    if (commandName === 'stop') {
        botState.isPlaying = false;
        botState.channelId = null;
        botState.mode = 'idle';
        queue = [];
        currentTrack = null;
        saveData();
        cleanupStreams();
        player.stop();
        const conn = getVoiceConnection(interaction.guild.id);
        if (conn) conn.destroy();
        return interaction.reply('👋 Đã dừng nhạc!');
    }
});

client.login(process.env.TOKEN);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Edward ϟ Radio is running online 24/7!\n');
}).listen(PORT, () => {
    console.log(`[Web Server] Đang lắng nghe trên cổng ${PORT}`);
});
