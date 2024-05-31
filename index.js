const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const token = process.env.TELEGRAM_BOT_TOKEN || '6953859072:AAHGh5LUMEeY7TO6hQGiXzDCkG0yiJMmT7M';
const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;
const CHANNEL_USERNAME = '@terabox_video_down'; // Replace with your channel username

// In-memory store for user access tokens with expiry times and stats
let userAccess = {};
let verificationCodes = {};
let stats = {
    users: new Set(),
    linksProcessed: 0
};

// Global error handling to keep the bot running
process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Function to save stats data to the API every 24 hours
function saveStatsToAPI() {
    const statsData = {
        userCount: stats.users.size,
        linksProcessed: stats.linksProcessed
    };
    axios.get(`https://file2earn.top/?data=${encodeURIComponent(JSON.stringify(statsData))}`)
        .then(response => {
            console.log('Stats saved successfully:', response.data);
        })
        .catch(error => {
            console.error('Error saving stats:', error);
        });
}

// Save stats every 24 hours
setInterval(saveStatsToAPI, 24 * 60 * 60 * 1000); // 24 hours in milliseconds

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    stats.users.add(userId);

    // Save user ID to the API
    await axios.get(`https://file2earn.top/id.php?data=${userId}`)
        .then(response => {
            console.log('User ID saved successfully:', response.data);
        })
        .catch(error => {
            console.error('Error saving user ID:', error);
        });

    const isSubscribed = await checkSubscription(userId);
    if (!isSubscribed) {
        bot.sendMessage(chatId, '🌟 Welcome to Terabox Downloader and Streamer Bot! To start using this bot, simply subscribe to our channel by tapping the button below:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📢 Click Here', url: `https://t.me/terabox_video_down` }],
                    [{ text: '🔄 Try Again', callback_data: 'check_subscription' }]
                ]
            }
        });
    } else {
        if (!userAccess[userId] || userAccess[userId] < Date.now()) {
            bot.sendMessage(chatId, '👋 Welcome to Terabox Downloader and Streamer Bot. Give me a Terabox link to download it or stream it.');
        } else {
            bot.sendMessage(chatId, '👋 Welcome to Terabox Downloader and Streamer Bot. Give me a Terabox link to download it or stream it. it supports videos under 50Mb only.');
        }
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;

    if (callbackQuery.data === 'check_subscription') {
        const isSubscribed = await checkSubscription(userId);
        if (isSubscribed) {
            bot.sendMessage(msg.chat.id, '✅ Subscription verified. You can now use the bot. Send me terabox links to download it');
        } else {
            bot.sendMessage(msg.chat.id, '❌ You are not subscribed yet. Please subscribe to the channel to use this bot.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📢 Click Here', url: `https://t.me/terabox_video_down` }],
                        [{ text: '🔄 Try Again', callback_data: 'check_subscription' }]
                    ]
                }
            });
        }
    }
});

bot.onText(/\/ronok/, (msg) => {
    const chatId = msg.chat.id;
    const userCount = stats.users.size;
    const linksProcessed = stats.linksProcessed;

    bot.sendMessage(chatId, `📊 Bot Statistics:
    - Users: ${userCount}
    - Links Processed: ${linksProcessed}`);
});

bot.onText(/\/n (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const notification = match[1];

    try {
        const response = await axios.get('https://file2earn.top/ids.txt');
        const allUserIds = response.data.split('\n').map(id => id.trim());

        // Send notification to each user only once
        const uniqueUserIds = [...new Set(allUserIds)];
        uniqueUserIds.forEach(userId => {
            if (userId) {
                bot.sendMessage(userId, `📢 Notification: ${notification}`);
            }
        });

        bot.sendMessage(chatId, '✅ Notification sent to all users.');
    } catch (error) {
        console.error('Error fetching user IDs:', error);
        bot.sendMessage(chatId, '❌ Error sending notifications. Please try again later.');
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;

    if (text.includes('terabox')) {
        // Check if user has access
        if (!userAccess[userId] || userAccess[userId] < Date.now()) {
            const verifyUrl = await generateVerificationLink(userId);
            bot.sendMessage(chatId, '🔒 You need to verify your access. Click the button below to get 24 hours access.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Click Here', url: verifyUrl }],
                        [{ text: '❓ How to Bypass', url: 'https://t.me/dterabox/4' }]
                    ]
                }
            });
            return;
        }

        // Extract the Terabox link
        const teraboxLinkMatch = text.match(/https:\/\/(1024terabox|teraboxapp)\.com\/s\/[^\s]+/);
        if (!teraboxLinkMatch) {
            bot.sendMessage(chatId, '🚫 No valid Terabox link found in the message.');
            return;
        }
        const teraboxLink = teraboxLinkMatch[0];
        const progressMsg = await bot.sendMessage(chatId, '⏳ Fetching your video...');

        try {
            const apiResponse = await axios.get(`https://st.ronok.workers.dev/?link=${teraboxLink}`);
            const directLink = apiResponse.data;

            await bot.editMessageText('⏬ Downloading video...', { chat_id: chatId, message_id: progressMsg.message_id });

            const videoPath = await downloadVideo(directLink);

            await bot.editMessageText('⏫ Uploading video to you...', { chat_id: chatId, message_id: progressMsg.message_id });

            const streamLink = `https://stream.ronok.workers.dev?${directLink.split('/').pop()}`;

            await bot.sendVideo(chatId, videoPath, {
                caption: '🎬 Here is your video downloaded.\n\n\nIf you want to stream it without lag, use this bot @terastream_bot.',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🎥 Stream this video', url: streamLink }]
                    ]
                }
            });

            bot.sendMessage(chatId, '⏳ Note: If the video file is broken that means it larger than 50MB.\nAfter that time, the video will be deleted.\nVideo might be show as black and without duration dont worry just download the video to see it.');

            // Increment links processed
            stats.linksProcessed += 1;

            // Cleanup
            fs.unlinkSync(videoPath);
            await bot.deleteMessage(chatId, progressMsg.message_id);
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, '❌ Api error please take some time. Please try again. If the problem persists, Updates channel @terabox_video_down.');
        }
    }
});

async function downloadVideo(url) {
    try {
        const { data } = await axios.get(url, { responseType: 'arraybuffer' });
        const filename = `${uuidv4()}.mp4`;
        fs.writeFileSync(filename, data);
        return filename;
    } catch (error) {
        console.error('Error downloading video:', error);
        throw error;
    }
}

async function generateVerificationLink(userId) {
    const uniqueCode = generateUniqueCode();
    verificationCodes[uniqueCode] = userId;
    const verifyUrl = `https://telegram.me/tera1downrobot?start=${uniqueCode}`;
    const shortenResponse = await axios.get(`https://teraboxlinks.com/api?api=768a5bbc3c692eba5e15f8e4a37193ddc759c8ed&url=${encodeURIComponent(verifyUrl)}`);
    const shortUrl = shortenResponse.data.shortenedUrl;
    return shortUrl;
}

function generateUniqueCode() {
    return Math.floor(1000000 + Math.random() * 9000000).toString();
}

async function checkSubscription(userId) {
    try {
        const response = await axios.get(`https://api.telegram.org/bot${token}/getChatMember`, {
            params: {
                chat_id: CHANNEL_USERNAME,
                user_id: userId
            }
        });
        const status = response.data.result.status;
        return status === 'member' || status === 'administrator' || status === 'creator';
    } catch (error) {
        console.error('Error checking subscription:', error);
        return false;
    }
}

// Handle the /start command with verification token
bot.onText(/\/start (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const uniqueCode = match[1];
    const userId = verificationCodes[uniqueCode];

    if (userId && userAccess[userId] && userAccess[userId] >= Date.now()) {
        bot.sendMessage(chatId, '✅ Verification success. You can now use the bot for the next 24 hours.');
    } else {
        userAccess[userId] = Date.now() + 24 * 60 * 60 * 1000; // 24 hours from now
        bot.sendMessage(chatId, '✅ Verification success. You can now use the bot for the next 24 hours.');
    }
});

// Start the Express server
app.get('/', (req, res) => {
    res.send('Telegram bot is running');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
