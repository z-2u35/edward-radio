require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

const {
    Client,
    GatewayIntentBits,
    ActivityType,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
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

// Danh sách đài Radio 24/7 mặc định
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
    mode: 'radio' // 'radio', 'queue', 'idle'
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

// Phát Radio trực tiếp
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
    
    req.on('error', (err) => {
        console.error(`[Edward ϟ Radio] Lỗi kết nối đài: ${err.message}`);
        if (botState.isPlaying && botState.mode === 'radio') {
            retryTimeout = setTimeout(() => playRadioStream(), 6000);
        }
    });
}

// Phát bài hát đơn từ YouTube/Link
async function playTrack(track) {
    cleanupStreams();
    currentTrack = track;
    botState.mode = 'queue'; 
    console.log(`[Edward ϟ Radio] Đang phát bài hát: ${track.title}`);

    try {
        const streamUrl = await youtubedl(track.url, {
            getUrl: true,
            format: 'bestaudio/best',
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true
        });

        const finalUrl = typeof streamUrl === 'string' ? streamUrl.trim().split('\n')[0] : track.url;

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

        ffmpegProcess.on('error', (err) => {
            console.error('[FFmpeg Process Error]:', err.message);
        });

        currentResource = createAudioResource(ffmpegProcess.stdout, { 
            inputType: StreamType.Raw, 
            inlineVolume: true 
        });
        
        currentResource.volume.setVolume(botState.volume / 100);
        player.play(currentResource);
        botState.isPlaying = true;
        saveData();

        console.log('🎶 [Edward ϟ Radio] Đang phát âm thanh ra kênh thoại (Vòng xanh đã bật)!');

        if (client.user) {
            client.user.setActivity(track.title, { type: ActivityType.Listening });
        }
    } catch (err) {
        console.error('Lỗi phát nhạc:', err.message);
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
        console.log('[Edward ϟ Radio] Đã phát xong toàn bộ hàng đợi. Bot đang ở chế độ chờ.');
        if (client.user) {
            client.user.setActivity('edp để phát nhạc', { type: ActivityType.Listening });
        }
    }
}

// Xử lý khi trình phát rảnh rỗi (Idle)
player.on(AudioPlayerStatus.Idle, () => {
    if (botState.mode === 'queue') {
        playNextInQueue();
    } else if (botState.mode === 'radio' && botState.isPlaying) {
        console.log('[Edward ϟ Radio] Luồng Radio kết thúc, đang tải lại...');
        retryTimeout = setTimeout(() => playRadioStream(), 3000);
    }
});

// Kết nối Voice Channel
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

    if (botState.mode === 'queue' && currentTrack) {
        // Giữ nguyên bài hiện tại nếu đang phát
    } else if (botState.mode === 'radio' && !botState.isPlaying) {
        playRadioStream();
    }
    return true;
}

// Đăng ký lệnh Slash Commands
async function registerCommands() {
    const stationChoices = Object.entries(STATIONS).map(([key, val]) => ({ name: val.name, value: key }));

    const commands = [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Phát bài hát từ YouTube, tên bài hát hoặc đài Radio')
            .addStringOption(opt => opt.setName('query').setDescription('Tên bài hát, từ khóa hoặc link YouTube').setRequired(false))
            .addStringOption(opt => opt.setName('station').setDescription('Hoặc chọn đài Radio phát 24/7').setRequired(false).addChoices(...stationChoices)),
        new SlashCommandBuilder().setName('skip').setDescription('Bỏ qua bài hát hiện tại trong hàng đợi'),
        new SlashCommandBuilder().setName('queue').setDescription('Xem danh sách hàng đợi bài hát'),
        new SlashCommandBuilder().setName('volume').setDescription('Chỉnh âm lượng (1-100)').addIntegerOption(opt => opt.setName('mức').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)),
        new SlashCommandBuilder().setName('247').setDescription('Bật hoặc tắt chế độ treo 24/7'),
        new SlashCommandBuilder()
            .setName('playlist')
            .setDescription('Quản lý bộ sưu tập (playlist) bài hát yêu thích')
            .addSubcommand(sub => sub.setName('create').setDescription('Tạo playlist mới').addStringOption(opt => opt.setName('tên').setDescription('Tên playlist').setRequired(true)))
            .addSubcommand(sub => sub.setName('add').setDescription('Thêm bài vào playlist').addStringOption(opt => opt.setName('tên').setDescription('Tên playlist').setRequired(true)).addStringOption(opt => opt.setName('query').setDescription('Tên bài hát hoặc link').setRequired(true)))
            .addSubcommand(sub => sub.setName('play').setDescription('Phát playlist').addStringOption(opt => opt.setName('tên').setDescription('Tên playlist').setRequired(true)))
            .addSubcommand(sub => sub.setName('list').setDescription('Xem danh sách playlist')),
        new SlashCommandBuilder().setName('stop').setDescription('Dừng nhạc và cho bot rời phòng')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(process.env.GUILD_ID ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID) : Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('[Edward ϟ Radio] Đã cập nhật bộ lệnh nhạc!');
}

client.once('clientReady', async () => {
    console.log(`⚡ ${client.user.tag} đã sẵn sàng!`);
    await registerCommands();
    if (botState.stay247 && botState.guildId && botState.channelId) {
        connectToVoice(botState.guildId, botState.channelId);
    }
});

// Xử lý các lệnh viết tắt (Prefix Commands): edp, eds, edq, edvol, ednp, edstop, ed247
const PREFIX = 'ed';
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // 1. edp hoặc edplay
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
            const searchRes = await youtubedl(`ytsearch1:${query}`, { dumpJson: true, noCheckCertificates: true });
            const track = { title: searchRes.title, url: searchRes.webpage_url, requester: message.author.tag };

            if ((botState.mode === 'radio' || botState.mode === 'idle') && !currentTrack && queue.length === 0) {
                playTrack(track);
                return message.reply(`🎶 Đang phát: **${track.title}**`);
            } else {
                queue.push(track);
                return message.reply(`➕ Đã thêm vào hàng đợi: **${track.title}** (Vị trí #${queue.length})`);
            }
        } catch (e) {
            return message.reply('❌ Không tìm thấy bài hát yêu cầu!');
        }
    }

    // 2. eds hoặc edskip
    if (command === 's' || command === 'skip') {
        if (botState.mode !== 'queue') return message.reply('❌ Không có bài hát nào trong hàng đợi để bỏ qua!');
        message.reply('⏭️ Đã bỏ qua bài hát hiện tại!');
        playNextInQueue();
    }

    // 3. edq hoặc edqueue
    if (command === 'q' || command === 'queue') {
        if (queue.length === 0 && !currentTrack) return message.reply('📭 Hàng đợi đang trống.');
        const list = queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
        const embed = new EmbedBuilder().setTitle('🎶 Hàng đợi bài hát').setDescription(`**Đang phát:** ${currentTrack?.title || 'Radio'}\n\n${list}`).setColor('#9B59B6');
        return message.reply({ embeds: [embed] });
    }

    // 4. edvol
    if (command === 'vol') {
        const vol = parseInt(args[0]);
        if (isNaN(vol) || vol < 1 || vol > 100) return message.reply('❌ Vui lòng nhập mức âm lượng từ 1 đến 100.');
        botState.volume = vol;
        if (currentResource) currentResource.volume.setVolume(vol / 100);
        saveData();
        return message.reply(`🔉 Đã chỉnh âm lượng thành **${vol}%**.`);
    }

    // 5. ed247 (Bật/tắt mode 24/7)
    if (command === '247') {
        botState.stay247 = !botState.stay247;
        saveData();
        return message.reply(
            botState.stay247
                ? '🟢 **Đã BẬT chế độ 24/7!** Edward ϟ Radio sẽ tự treo một mình trong phòng.'
                : '🔴 **Đã TẮT chế độ 24/7!** Bot sẽ tự rời phòng khi trống.'
        );
    }

    // 6. ednp
    if (command === 'np') {
        const station = STATIONS[botState.station] || STATIONS.lofi;
        const embed = new EmbedBuilder()
            .setColor('#8E44AD')
            .setTitle(botState.mode === 'queue' && currentTrack ? `Đang phát: ${currentTrack.title}` : `Đang phát đài: ${station.name}`)
            .addFields(
                { name: '🔊 Phòng thoại', value: botState.channelId ? `<#${botState.channelId}>` : 'Chưa kết nối', inline: true },
                { name: '🔉 Âm lượng', value: `\`${botState.volume}%\``, inline: true },
                { name: '♾️ Chế độ 24/7', value: botState.stay247 ? '`Bật`' : '`Tắt`', inline: true }
            );
        return message.reply({ embeds: [embed] });
    }

    // 7. edstop
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
        return message.reply('👋 Đã dừng nhạc và rời phòng!');
    }
});

// Xử lý Slash Commands & Playlist
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
            const searchRes = await youtubedl(`ytsearch1:${query}`, { dumpJson: true, noCheckCertificates: true });
            const track = { title: searchRes.title, url: searchRes.webpage_url, requester: interaction.user.tag };

            if ((botState.mode === 'radio' || botState.mode === 'idle') && !currentTrack && queue.length === 0) {
                playTrack(track);
                return interaction.editReply(`🎶 Đang phát: **${track.title}**`);
            } else {
                queue.push(track);
                return interaction.editReply(`➕ Đã thêm vào hàng đợi: **${track.title}** (Vị trí #${queue.length})`);
            }
        } catch (e) {
            return interaction.editReply('❌ Không tìm thấy bài hát yêu cầu!');
        }
    }

    if (commandName === 'skip') {
        if (botState.mode !== 'queue') return interaction.reply({ content: '❌ Không có hàng đợi để bỏ qua!', flags: MessageFlags.Ephemeral });
        interaction.reply('⏭️ Đã bỏ qua bài hát hiện tại!');
        playNextInQueue();
    }

    if (commandName === 'queue') {
        if (queue.length === 0 && !currentTrack) return interaction.reply('📭 Hàng đợi đang trống.');
        const list = queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
        const embed = new EmbedBuilder().setTitle('🎶 Hàng đợi bài hát').setDescription(`**Đang phát:** ${currentTrack?.title || 'Radio'}\n\n${list}`).setColor('#9B59B6');
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
        return interaction.reply(
            botState.stay247
                ? '🟢 **Đã BẬT chế độ 24/7!** Edward ϟ Radio sẽ tự treo một mình trong phòng.'
                : '🔴 **Đã TẮT chế độ 24/7!** Bot sẽ tự rời phòng khi trống.'
        );
    }

    if (commandName === 'playlist') {
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        if (!userPlaylists[userId]) userPlaylists[userId] = {};

        if (sub === 'create') {
            const name = interaction.options.getString('tên');
            if (userPlaylists[userId][name]) return interaction.reply({ content: '❌ Playlist này đã tồn tại!', flags: MessageFlags.Ephemeral });
            userPlaylists[userId][name] = [];
            saveData();
            return interaction.reply(`📁 Đã tạo thành công bộ sưu tập **${name}**!`);
        }

        if (sub === 'add') {
            const name = interaction.options.getString('tên');
            const query = interaction.options.getString('query');
            if (!userPlaylists[userId][name]) return interaction.reply({ content: '❌ Không tìm thấy playlist này!', flags: MessageFlags.Ephemeral });

            await interaction.deferReply();
            try {
                const searchRes = await youtubedl(`ytsearch1:${query}`, { dumpJson: true, noCheckCertificates: true });
                userPlaylists[userId][name].push({ title: searchRes.title, url: searchRes.webpage_url });
                saveData();
                return interaction.editReply(`✅ Đã thêm **${searchRes.title}** vào playlist **${name}**.`);
            } catch (e) {
                return interaction.editReply('❌ Không thể tìm thấy bài hát để thêm vào playlist.');
            }
        }

        if (sub === 'list') {
            const lists = Object.keys(userPlaylists[userId]);
            if (lists.length === 0) return interaction.reply('📭 Bạn chưa tạo bộ sưu tập nào.');
            const desc = lists.map(l => `• **${l}** (${userPlaylists[userId][l].length} bài)`).join('\n');
            const embed = new EmbedBuilder().setTitle('📚 Bộ sưu tập của bạn').setDescription(desc).setColor('#3498DB');
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'play') {
            const name = interaction.options.getString('tên');
            const pl = userPlaylists[userId][name];
            if (!pl || pl.length === 0) return interaction.reply({ content: '❌ Playlist trống hoặc không tồn tại!', flags: MessageFlags.Ephemeral });

            const userVoice = interaction.member.voice.channel;
            if (!userVoice) return interaction.reply({ content: '❌ Bạn phải vào phòng thoại!', flags: MessageFlags.Ephemeral });

            await interaction.deferReply();
            await connectToVoice(interaction.guild.id, userVoice.id);

            queue.push(...pl);
            if (botState.mode !== 'queue') {
                playNextInQueue();
            }
            return interaction.editReply(`🎶 Đã nạp **${pl.length} bài hát** từ playlist **${name}** vào hàng đợi!`);
        }
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
        return interaction.reply('👋 Đã dừng nhạc và rời phòng!');
    }
});

client.login(process.env.TOKEN);

// Tạo Web Server HTTP đơn giản ở cuối file (dùng chung biến http ở đầu file) để chống ngủ đông trên Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Edward ϟ Radio is running online 24/7!\n');
}).listen(PORT, () => {
    console.log(`[Web Server] Đang lắng nghe trên cổng ${PORT}`);
});