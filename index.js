require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
    Client,
    GatewayIntentBits,
    ChannelType,
    ActivityType,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
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
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');

const requiredEnv = ['TOKEN', 'CLIENT_ID'];
const missingEnv = requiredEnv.filter(name => !process.env[name]);
if (missingEnv.length > 0) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${missingEnv.join(', ')}`);
}

// Danh sách các đài Radio trực tuyến 24/7
const STATIONS = {
    lofi: { name: '☕ Lofi Hip Hop Beats', url: 'https://lfhh.radioca.st/stream', desc: 'Nhạc Lofi thư giãn, học bài & làm việc' },
    chill: { name: '🌙 Chillsynth / Nightwave', url: 'https://radio.plaza.one/mp3', desc: 'Giai điệu Synthwave & Aesthetic ban đêm' },
    jazz: { name: '🎷 Smooth Jazz 24/7', url: 'https://streaming.live365.com/a49833', desc: 'Nhạc Jazz nhẹ nhàng, sang trọng' },
    piano: { name: '🎹 Peaceful Piano', url: 'https://pianosolo.stream.laut.fm/pianosolo', desc: 'Độc tấu Piano êm dịu, dễ ngủ' },
    asian: { name: '🏮 Asian Lofi Radio', url: 'https://stream.zeno.fm/0r0xa792kwzuv', desc: 'Lofi mang âm hưởng Á Đông' },
    rain: { name: '🌧️ Rainy Lofi Vibes', url: 'https://stream.zeno.fm/f3wvbbqmdg8uv', desc: 'Giai điệu Lofi kết hợp tiếng mưa rơi' }
};

// File lưu trạng thái để bot tự nhớ phòng 24/7 khi khởi động lại
const STATE_FILE = path.join(__dirname, 'state.json');

let botState = {
    guildId: null,
    channelId: null,
    station: 'lofi',
    volume: 50,
    stay247: true,
    isPlaying: false,
    invitedByUserId: null
};

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            botState = { ...botState, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
        } catch (e) {
            console.error('[Edward ϟ Radio] Không thể đọc file state.json:', e);
        }
    }
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
    } catch (error) {
        console.error('[Edward ϟ Radio] Không thể lưu state.json:', error);
    }
}

loadState();

let currentResource = null;
let ffmpegProcess = null;
let reconnectTimer = null;
let currentSource = null;

// Khởi tạo Audio Player không tự ngắt khi phòng trống
const player = createAudioPlayer({
    behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
    }
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Hàm phát luồng Radio
function stopCurrentAudio() {
    if (ffmpegProcess) {
        ffmpegProcess.kill();
        ffmpegProcess = null;
    }
    currentResource = null;
}

function createRadioResource(station) {
    const process = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', station.url,
        '-vn',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);

    ffmpegProcess = process;
    process.stderr.on('data', data => {
        const message = data.toString().trim();
        if (message) console.error(`[Edward ϟ Radio] FFmpeg: ${message}`);
    });
    process.on('error', error => {
        console.error(`[Edward ϟ Radio] Không thể khởi động FFmpeg: ${error.message}`);
    });
    process.on('close', () => {
        if (ffmpegProcess === process) ffmpegProcess = null;
    });

    return createAudioResource(process.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true
    });
}

async function playSource(source) {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    stopCurrentAudio();
    currentSource = source;

    let resource;
    if (source.kind === 'radio') {
        console.log(`[Edward ϟ Radio] Đang phát: ${source.title}`);
        resource = createRadioResource(source.station);
    } else {
        console.log(`[Edward ϟ Radio] Đang tải: ${source.title}`);
        const audio = await play.stream(source.url, { discordPlayerCompatibility: true });
        resource = createAudioResource(audio.stream, {
            inputType: audio.type,
            inlineVolume: true
        });
    }

    currentResource = resource;
    currentResource.volume.setVolume(botState.volume / 100);

    player.play(currentResource);
    botState.isPlaying = true;
    saveState();

    if (client.user) {
        client.user.setActivity(`${source.title} | /play`, { type: ActivityType.Listening });
    }
}

function playRadio() {
    const station = STATIONS[botState.station] || STATIONS.lofi;
    return playSource({
        kind: 'radio',
        station,
        title: station.name,
        desc: station.desc
    });
}

async function resolveTrack(query) {
    if (play.yt_validate(query) === 'video') {
        const info = await play.video_basic_info(query);
        return { kind: 'track', url: query, title: info.video_details.title };
    }

    if (play.sp_validate(query) === 'track') {
        const spotifyTrack = await play.spotify(query);
        await spotifyTrack.load();
        const searchTerm = `${spotifyTrack.name} ${spotifyTrack.artists.map(artist => artist.name).join(' ')}`;
        const results = await play.search(searchTerm, { limit: 1, source: { youtube: 'video' } });
        if (!results[0]) throw new Error('Không tìm thấy bản YouTube tương ứng với bài Spotify.');
        return { kind: 'track', url: results[0].url, title: `${spotifyTrack.name} (Spotify)` };
    }

    const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
    if (!results[0]) throw new Error('Không tìm thấy bài hát phù hợp.');
    return { kind: 'track', url: results[0].url, title: results[0].title };
}

// Tự động kết nối lại luồng nhạc nếu bị ngắt
player.on(AudioPlayerStatus.Idle, () => {
    if (botState.isPlaying) {
        console.log('[Edward ϟ Radio] Luồng nhạc bị gián đoạn, đang tải lại sau 3 giây...');
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                playSource(currentSource || { kind: 'radio', station: STATIONS.lofi, title: STATIONS.lofi.name })
                    .catch(error => console.error('[Edward ϟ Radio] Reconnect nguồn thất bại:', error.message));
            }, 3000);
        }
    }
});

player.on('error', error => {
    console.error(`[Edward ϟ Radio] Lỗi âm thanh: ${error.message}`);
    if (botState.isPlaying) {
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                playSource(currentSource || { kind: 'radio', station: STATIONS.lofi, title: STATIONS.lofi.name })
                    .catch(error => console.error('[Edward ϟ Radio] Reconnect nguồn thất bại:', error.message));
            }, 5000);
        }
    }
});

// Hàm vào phòng thoại và giữ kết nối
async function connectAndPlay(guildId, channelId, inviterUserId, startPlayback = true) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return false;

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return false;

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
    });

    connection.subscribe(player);
    botState.guildId = guildId;
    botState.channelId = channelId;
    if (inviterUserId) botState.invitedByUserId = inviterUserId;
    saveState();
    if (startPlayback) {
        await playSource(currentSource || {
            kind: 'radio',
            station: STATIONS[botState.station] || STATIONS.lofi,
            title: (STATIONS[botState.station] || STATIONS.lofi).name,
            desc: (STATIONS[botState.station] || STATIONS.lofi).desc
        });
    }

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch (error) {
            if (botState.stay247 && botState.isPlaying && botState.channelId) {
                console.log('[Edward ϟ Radio] Mất kết nối! Đang tự động vào lại phòng 24/7...');
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
                setTimeout(() => connectAndPlay(botState.guildId, botState.channelId, botState.invitedByUserId), 5000);
            }
        }
    });

    return true;
}

function getTargetVoiceChannel(guild, member, requestedChannel) {
    if (requestedChannel) return requestedChannel.isVoiceBased() ? requestedChannel : null;
    if (member.voice.channel) return member.voice.channel;
    if (botState.guildId === guild.id && botState.channelId) {
        return guild.channels.cache.get(botState.channelId) || null;
    }
    return null;
}

function canInviteUserLeave(userId, guildId) {
    return botState.guildId === guildId && botState.invitedByUserId === userId;
}

async function leaveVoice(guildId) {
    const connection = getVoiceConnection(guildId);
    botState.isPlaying = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    stopCurrentAudio();
    player.stop();
    if (connection) connection.destroy();
    botState.guildId = null;
    botState.channelId = null;
    botState.invitedByUserId = null;
    saveState();
    client.user.setActivity('/join để vào phòng', { type: ActivityType.Listening });
}

// Tạo các nút bấm điều khiển nhanh giống Lofi Radio
function createControlButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('btn_pause_resume')
            .setLabel(player.state.status === AudioPlayerStatus.Paused ? '▶️ Tiếp tục' : '⏸️ Tạm dừng')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('btn_random')
            .setLabel('🔀 Đổi đài ngẫu nhiên')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('btn_247')
            .setLabel(`24/7: ${botState.stay247 ? 'BẬT' : 'TẮT'}`)
            .setStyle(botState.stay247 ? ButtonStyle.Success : ButtonStyle.Danger)
    );
}

// Tạo Embed hiển thị trạng thái phát nhạc
function createNowPlayingEmbed() {
    const source = currentSource || {
        title: STATIONS[botState.station].name,
        desc: STATIONS[botState.station].desc
    };
    return new EmbedBuilder()
        .setColor('#8E44AD')
        .setAuthor({ name: 'Edward ϟ Radio — Bảng Điều Khiển', iconURL: client.user.displayAvatarURL() })
        .setTitle(`Đang phát: ${source.title}`)
        .setDescription(source.desc ? `*${source.desc}*` : '*Nguồn phát trực tuyến*')
        .addFields(
            { name: '🔊 Phòng thoại', value: botState.channelId ? `<#${botState.channelId}>` : 'Chưa kết nối', inline: true },
            { name: '🔉 Âm lượng', value: `\`${botState.volume}%\``, inline: true },
            { name: '♾️ Chế độ 24/7', value: botState.stay247 ? '`🟢 Đang Bật`' : '`🔴 Đang Tắt`', inline: true }
        )
        .setFooter({ text: 'Sử dụng /play để đổi đài hoặc /stop để bot rời phòng' })
        .setTimestamp();
}

// Đăng ký bộ lệnh Slash Commands
async function registerCommands() {
    const stationChoices = Object.entries(STATIONS).map(([key, val]) => ({
        name: val.name,
        value: key
    }));

    const commands = [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Phát radio, link YouTube, Spotify hoặc tìm bài hát')
            .addStringOption(opt =>
                opt.setName('station')
                    .setDescription('Chọn đài radio')
                    .setRequired(false)
                    .addChoices(...stationChoices)
            )
            .addStringOption(opt =>
                opt.setName('query')
                    .setDescription('Tên bài hát hoặc link YouTube/Spotify')
                    .setRequired(false)
            ),
        new SlashCommandBuilder()
            .setName('join')
            .setDescription('Đưa bot vào phòng thoại')
            .addChannelOption(opt =>
                opt.setName('room')
                    .setDescription('Phòng thoại đích; bỏ trống để dùng phòng hiện tại')
                    .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
                    .setRequired(false)
            ),
        new SlashCommandBuilder()
            .setName('leave')
            .setDescription('Đưa bot rời phòng; chỉ người đã mời bot mới dùng được'),
        new SlashCommandBuilder()
            .setName('station')
            .setDescription('Xem danh sách các đài Radio hiện có trên Edward ϟ Radio'),
        new SlashCommandBuilder()
            .setName('volume')
            .setDescription('Điều chỉnh âm lượng của Edward ϟ Radio (1 - 100)')
            .addIntegerOption(opt =>
                opt.setName('level')
                    .setDescription('Nhập mức âm lượng từ 1 đến 100')
                    .setMinValue(1)
                    .setMaxValue(100)
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('247')
            .setDescription('Bật hoặc tắt chế độ tự treo 24/7 một mình trong phòng'),
        new SlashCommandBuilder()
            .setName('nowplaying')
            .setDescription('Xem thông tin đài đang phát và bảng điều khiển'),
        new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Dừng nhạc, tắt 24/7 và cho Edward ϟ Radio rời phòng thoại'),
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Xem danh sách toàn bộ lệnh của Edward ϟ Radio')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        if (process.env.GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        } else {
            await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        }
        console.log('[Edward ϟ Radio] Đã đăng ký đầy đủ các lệnh Slash!');
    } catch (error) {
        console.error('Lỗi đăng ký lệnh:', error);
    }
}

client.once('ready', async () => {
    console.log(`⚡ ${client.user.tag} đã sẵn sàng!`);
    await registerCommands();

    // Nếu trước khi tắt bot đang ở chế độ 24/7 tại phòng nào đó, tự động vào lại
    if (botState.stay247 && botState.isPlaying && botState.guildId && botState.channelId) {
        console.log('[Edward ϟ Radio] Khôi phục phiên treo 24/7 từ lần chạy trước...');
        connectAndPlay(botState.guildId, botState.channelId, botState.invitedByUserId);
    } else {
        client.user.setActivity('/play để nghe nhạc 24/7', { type: ActivityType.Listening });
    }
});

// Kiểm tra sự kiện phòng thoại (Tự vào lại nếu bị kick khi bật 24/7, hoặc tự rời nếu tắt 24/7 và phòng trống)
client.on('voiceStateUpdate', (oldState, newState) => {
    // 1. Trường hợp bot bị ngắt kết nối / bị kick thủ công
    if (oldState.member.id === client.user.id && oldState.channelId && !newState.channelId) {
        if (botState.stay247 && botState.isPlaying && botState.channelId) {
            console.log('[Edward ϟ Radio] Bị ngắt khỏi phòng nhưng chế độ 24/7 đang BẬT -> Tự vào lại sau 3s...');
            setTimeout(() => connectAndPlay(botState.guildId, botState.channelId, botState.invitedByUserId), 3000);
        }
        return;
    }

    // 2. Trường hợp người dùng rời phòng và chế độ 24/7 đang TẮT
    if (!botState.stay247 && botState.channelId && oldState.channelId === botState.channelId) {
        const channel = oldState.guild.channels.cache.get(botState.channelId);
        if (channel) {
            const humanMembers = channel.members.filter(m => !m.user.bot);
            if (humanMembers.size === 0) {
                console.log('[Edward ϟ Radio] Phòng trống và chế độ 24/7 đang TẮT -> Tự rời phòng.');
                player.stop();
                if (ffmpegProcess) {
                    ffmpegProcess.kill();
                    ffmpegProcess = null;
                }
                const conn = getVoiceConnection(oldState.guild.id);
                if (conn) conn.destroy();
                botState.isPlaying = false;
                botState.channelId = null;
                botState.guildId = null;
                botState.invitedByUserId = null;
                saveState();
            }
        }
    }
});

// Xử lý Slash Commands & Nút bấm
client.on('interactionCreate', async interaction => {
    // XỬ LÝ NÚT BẤM (BUTTONS)
    if (interaction.isButton()) {
        const userVoice = interaction.member.voice.channel;
        if (!userVoice || userVoice.id !== botState.channelId) {
            return interaction.reply({ content: '❌ Bạn phải ở cùng phòng thoại với bot để bấm nút điều khiển!', ephemeral: true });
        }

        if (interaction.customId === 'btn_pause_resume') {
            if (player.state.status === AudioPlayerStatus.Paused) {
                player.unpause();
            } else {
                player.pause();
            }
            return interaction.update({ embeds: [createNowPlayingEmbed()], components: [createControlButtons()] });
        }

        if (interaction.customId === 'btn_random') {
            const keys = Object.keys(STATIONS).filter(k => k !== botState.station);
            botState.station = keys[Math.floor(Math.random() * keys.length)];
            await playRadio();
            return interaction.update({ embeds: [createNowPlayingEmbed()], components: [createControlButtons()] });
        }

        if (interaction.customId === 'btn_247') {
            botState.stay247 = !botState.stay247;
            saveState();
            return interaction.update({ embeds: [createNowPlayingEmbed()], components: [createControlButtons()] });
        }
    }

    // XỬ LÝ LỆNH SLASH (/play, /stop, /volume,...)
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'join') {
        const requestedChannel = interaction.options.getChannel('room');
        const target = getTargetVoiceChannel(interaction.guild, interaction.member, requestedChannel);
        if (!target) {
            return interaction.reply({ content: '❌ Hãy chọn `room` hoặc vào một phòng thoại trước.', ephemeral: true });
        }
        const inviter = botState.channelId === target.id ? botState.invitedByUserId : interaction.user.id;
        const connected = await connectAndPlay(interaction.guild.id, target.id, inviter, false);
        if (!connected) return interaction.reply({ content: '❌ Bot không thể vào phòng thoại này.', ephemeral: true });
        return interaction.reply(`✅ Đã vào <#${target.id}>. Chỉ người gọi lệnh này mới có quyền dùng \/leave.`);
    }

    if (commandName === 'leave') {
        if (!canInviteUserLeave(interaction.user.id, interaction.guild.id)) {
            return interaction.reply({ content: '❌ Chỉ người đã mời bot vào phòng hiện tại mới có thể dùng lệnh này.', ephemeral: true });
        }
        await leaveVoice(interaction.guild.id);
        return interaction.reply('👋 Bot đã rời phòng thoại.');
    }

    if (commandName === 'play') {
        const target = getTargetVoiceChannel(interaction.guild, interaction.member, null);
        if (!target) {
            return interaction.reply({ content: '❌ Hãy vào phòng thoại hoặc dùng `/join room` trước.', ephemeral: true });
        }

        const chosenStation = interaction.options.getString('station');
        const query = interaction.options.getString('query');
        const inviter = botState.channelId === target.id ? botState.invitedByUserId : interaction.user.id;
        const connected = await connectAndPlay(interaction.guild.id, target.id, inviter, false);
        if (!connected) return interaction.reply({ content: '❌ Bot không thể vào phòng thoại này.', ephemeral: true });

        try {
            if (query) {
                await playSource(await resolveTrack(query));
            } else {
                if (chosenStation) botState.station = chosenStation;
                await playRadio();
            }
        } catch (error) {
            console.error('[Edward ϟ Radio] Không thể phát nguồn:', error);
            return interaction.reply({ content: `❌ Không thể phát nguồn này: ${error.message}`, ephemeral: true });
        }

        return interaction.reply({ embeds: [createNowPlayingEmbed()], components: [createControlButtons()] });
    }

    if (commandName === 'station') {
        const list = Object.entries(STATIONS)
            .map(([key, val]) => `• **${val.name}** (\`${key}\`)\n  └ *${val.desc}*`)
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('📻 Danh sách các đài của Edward ϟ Radio')
            .setDescription(`${list}\n\n💡 **Mẹo:** Gõ lệnh \`/play [kênh]\` để chọn đài bạn muốn phát!`)
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'volume') {
        if (!botState.isPlaying || !currentResource) {
            return interaction.reply({ content: '❌ Bot hiện chưa phát nhạc! Hãy dùng `/play` trước.', ephemeral: true });
        }

        const vol = interaction.options.getInteger('level');
        botState.volume = vol;
        currentResource.volume.setVolume(vol / 100);
        saveState();

        return interaction.reply(`🔉 Đã điều chỉnh âm lượng của **Edward ϟ Radio** thành **${vol}%**.`);
    }

    if (commandName === '247') {
        botState.stay247 = !botState.stay247;
        saveState();

        return interaction.reply(
            botState.stay247
                ? '🟢 **Đã BẬT chế độ 24/7!** Edward ϟ Radio sẽ tự treo một mình trong phòng không giới hạn thời gian.'
                : '🔴 **Đã TẮT chế độ 24/7!** Bot sẽ tự rời phòng nếu không còn ai nghe.'
        );
    }

    if (commandName === 'nowplaying') {
        if (!botState.isPlaying) {
            return interaction.reply({ content: '❌ Hiện không có đài nào đang phát. Hãy dùng `/play` để bắt đầu!', ephemeral: true });
        }
        return interaction.reply({
            embeds: [createNowPlayingEmbed()],
            components: [createControlButtons()]
        });
    }

    if (commandName === 'stop') {
        if (!canInviteUserLeave(interaction.user.id, interaction.guild.id)) {
            return interaction.reply({ content: '❌ Chỉ người đã mời bot vào phòng hiện tại mới có thể dừng bot.', ephemeral: true });
        }
        await leaveVoice(interaction.guild.id);
        return interaction.reply('👋 **Edward ϟ Radio** đã dừng phát nhạc và rời khỏi phòng thoại.');
    }

    if (commandName === 'help') {
        const embed = new EmbedBuilder()
            .setColor('#F1C40F')
            .setAuthor({ name: 'Edward ϟ Radio — Hướng dẫn sử dụng', iconURL: client.user.displayAvatarURL() })
            .setDescription('Bot phát nhạc Lofi & Chill tự động treo phòng 24/7.')
            .addFields(
                { name: '`/play [kênh]`', value: 'Gọi bot vào phòng thoại của bạn và bắt đầu phát nhạc.' },
                { name: '`/station`', value: 'Xem toàn bộ danh sách các đài Radio hiện có.' },
                { name: '`/247`', value: 'Bật/Tắt chế độ tự động treo 24/7 kể cả khi phòng trống.' },
                { name: '`/volume [1-100]`', value: 'Tăng/giảm âm lượng phát nhạc trực tiếp.' },
                { name: '`/nowplaying`', value: 'Mở lại bảng điều khiển nút bấm và xem đài đang phát.' },
                { name: '`/stop`', value: 'Cho phép bot dừng nhạc và thoát khỏi phòng thoại.' }
            )
            .setFooter({ text: 'Edward ϟ Radio • Luôn đồng hành cùng bạn 24/7' });

        return interaction.reply({ embeds: [embed] });
    }
});

function findMessageVoiceChannel(message, args) {
    const mentionedChannel = message.mentions.channels.first();
    if (mentionedChannel && mentionedChannel.isVoiceBased()) return mentionedChannel;

    const channelId = args[0]?.match(/^<#(\d+)>$/)?.[1];
    if (channelId) {
        const channel = message.guild.channels.cache.get(channelId);
        return channel?.isVoiceBased() ? channel : null;
    }

    const requestedName = args.join(' ').trim().toLowerCase();
    if (requestedName) {
        return message.guild.channels.cache.find(channel =>
            channel.isVoiceBased() && channel.name.toLowerCase() === requestedName
        ) || null;
    }

    return message.member.voice.channel || null;
}

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const parts = message.content.trim().split(/\s+/);
    const command = parts.shift()?.toLowerCase();
    if (!['edj', 'edl', 'edp'].includes(command)) return;

    try {
        if (command === 'edj') {
            const target = findMessageVoiceChannel(message, parts);
            if (!target) return message.reply('❌ Dùng `edj` khi đang ở voice hoặc `edj #TênRoom`.');
            const inviter = botState.channelId === target.id ? botState.invitedByUserId : message.author.id;
            const connected = await connectAndPlay(message.guild.id, target.id, inviter, false);
            return message.reply(connected
                ? `✅ Đã vào <#${target.id}>. Chỉ bạn mới có thể dùng \`edl\`.`
                : '❌ Bot không thể vào phòng thoại này.');
        }

        if (command === 'edl') {
            if (!canInviteUserLeave(message.author.id, message.guild.id)) {
                return message.reply('❌ Chỉ người đã mời bot vào phòng hiện tại mới có thể dùng `edl`.');
            }
            await leaveVoice(message.guild.id);
            return message.reply('👋 Bot đã rời phòng thoại.');
        }

        const target = getTargetVoiceChannel(message.guild, message.member, null);
        if (!target) return message.reply('❌ Hãy vào voice trước hoặc dùng `edj #TênRoom`.');
        if (parts.length === 0) return message.reply('❌ Dùng `edp tên bài`, link YouTube hoặc link Spotify.');
        const inviter = botState.channelId === target.id ? botState.invitedByUserId : message.author.id;
        const connected = await connectAndPlay(message.guild.id, target.id, inviter, false);
        if (!connected) return message.reply('❌ Bot không thể vào phòng thoại này.');
        await playSource(await resolveTrack(parts.join(' ')));
        return message.reply(`▶️ Đang phát **${currentSource.title}**.`);
    } catch (error) {
        console.error(`[Edward ϟ Radio] Lỗi ${command}:`, error);
        return message.reply(`❌ Không thể xử lý lệnh: ${error.message}`);
    }
});

client.login(process.env.TOKEN);
